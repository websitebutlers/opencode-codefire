# Integrating CodeFire Terminal Agent into the CodeFire Desktop App

Last updated: 2026-05-23 · Targets `@codefireapp/agent@0.1.0-beta.3+`

This document is the programmatic-integration reference for the team building the main CodeFire app (Electron/desktop, web, or any other host) on top of `@codefireapp/agent`. It covers process spawning, identity, the HTTP control API, the TypeScript SDK, lifecycle events, MCP wiring, and end-to-end examples.

If you only want to *use* the CLI yourself, read the project `README.md` instead.

---

## 1. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                       CodeFire Desktop (host)                        │
│                                                                      │
│  ┌────────────────────┐    spawn     ┌────────────────────────────┐  │
│  │  Main process      │──────────────▶  codefire-agent (sidecar)  │  │
│  │   - lifecycle      │              │   - OpenCode core          │  │
│  │   - settings UI    │              │   - HTTP server (random    │  │
│  │   - chat UI        │◀──HTTP───────│     port on 127.0.0.1)     │  │
│  │   - MCP server     │   /codefire  │   - SSE + WS event stream  │  │
│  └────────────────────┘   /v1/*      │   - JSONL lifecycle stream │  │
│           │                          └──────┬─────────────────────┘  │
│           │                                 │                        │
│           ▼                                 ▼                        │
│      MCP tools                       ~/.codefire-agent/             │
│      (wiki/tasks/etc)               (data, config, cache, state)    │
└──────────────────────────────────────────────────────────────────────┘
```

Key design points:

- **The agent runs as a sidecar process** the desktop owns the lifecycle of. The desktop is the parent; the agent dies when the parent dies.
- **All cross-process state lives in `~/.codefire-agent/`** by default (overridable via `CODEFIRE_AGENT_HOME`). This is isolated from any existing `opencode` install so the two can coexist.
- **Identity is set via env vars at spawn time** (`CODEFIRE_AGENT=1` minimum; more for Agent Chat mode — see §3).
- **Two integration surfaces:**
  - **HTTP control API** at `/codefire/v1/*` for snapshots, settings, MCP status (this doc, §5)
  - **OpenCode v2 session API** (also exposed by the same HTTP server, separate paths) for actual chat sessions, tool calls, streaming output — covered by the upstream OpenCode SDK
- **Two event surfaces:**
  - **JSONL lifecycle** via `CODEFIRE_AGENT_LIFECYCLE_FILE` for spawn/ready/closed signals (§7)
  - **Session-level events** via the OpenCode SSE/WebSocket stream (covered by upstream docs)

---

## 2. Installing the agent as a dependency

```bash
# In the CodeFire desktop repo
npm install @codefireapp/agent@beta
```

This pulls the public wrapper package plus the platform binary for the host running `npm install` (resolved by the postinstall script). The wrapper bin lands at `node_modules/@codefireapp/agent/bin/codefire-agent`.

### Pinning

For production releases pin to an exact version:

```json
{
  "dependencies": {
    "@codefireapp/agent": "0.1.0-beta.3"
  }
}
```

The package follows semver inside the `beta` channel. Major versions will bump when the control-API contract breaks.

### Discovering the binary at runtime

```ts
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const pkgPath = require.resolve("@codefireapp/agent/package.json")
const pkgDir = path.dirname(pkgPath)
const agentBin = path.join(pkgDir, "bin", process.platform === "win32" ? "codefire-agent.cmd" : "codefire-agent")
```

(The Windows wrapper currently uses the JS wrapper through Node, not a `.cmd` shim. Use `process.execPath` to invoke it explicitly on Windows; see §3.)

---

## 3. Spawning the agent

The minimum invocation:

```ts
import { spawn } from "node:child_process"

const proc = spawn(agentBin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  env: {
    ...process.env,
    CODEFIRE_AGENT: "1",
    CODEFIRE_AGENT_HOME: "/path/to/your/desktop/agent-state",
    CODEFIRE_AGENT_LIFECYCLE_FILE: "/path/to/lifecycle.jsonl",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
```

### Required and recommended env vars

| Variable | Required | Purpose |
| --- | --- | --- |
| `CODEFIRE_AGENT=1` | yes | Switches identity, system prompts, branding, and (in beta.3+) upgrade-check routing. Auto-set by the wrapper bin if you launch via `codefire-agent` directly, but set it explicitly when spawning the inner binary or via Node. |
| `CODEFIRE_AGENT_HOME` | recommended | Override the default `~/.codefire-agent/` state dir. Lets you sandbox per-desktop-install (useful for multi-account or portable deployments). The agent creates `data/`, `config/`, `state/`, `cache/`, `tmp/` under this path. |
| `CODEFIRE_AGENT_LIFECYCLE_FILE` | recommended | Path to a writable file. When set, lifecycle events are appended as JSONL instead of printed to stderr. Tail this from the desktop to know when the sidecar is ready (see §7). |
| `CODEFIRE_AGENT_CHAT=1` | conditional | Sets `mode: "agent-chat"`. Use when the spawn is on behalf of an in-app chat session (vs the user running the standalone CLI). Auto-emits lifecycle events. |
| `CODEFIRE_PROJECT_ID` | conditional | UUID of the CodeFire project the spawn is scoped to. Surfaces in `runtime.projectID` everywhere and triggers `mode: "agent-chat"`. |
| `CODEFIRE_PARENT_THREAD_ID` | conditional | Numeric thread ID for handoff context. Surfaces in `runtime.parentThreadID` and triggers `mode: "agent-chat"`. |
| `CODEFIRE_HANDOFF_TITLE` | optional | Human-readable title for the handoff (shown in some prompts). |
| `CODEFIRE_MCP_URL` | optional | Remote URL for the CodeFire MCP server. Mutually exclusive with `CODEFIRE_MCP_COMMAND`. |
| `CODEFIRE_MCP_COMMAND` | optional | Local command for the CodeFire MCP server. Defaults to `codefire mcp`. JSON-array form is also accepted. |
| `CODEFIRE_MCP_NAME` | optional | Override the MCP server name (default `codefire`). |

### Discovering the spawned port

`serve --port 0` tells the OS to assign a free port. The agent prints `opencode server listening on http://127.0.0.1:<port>` to stdout once ready. Parse that or — better — wait for the `runtime.started` lifecycle event (§7) and read the port from there.

For now, the simplest pattern is to scan stdout:

```ts
import readline from "node:readline"

const port: number = await new Promise((resolve, reject) => {
  const rl = readline.createInterface({ input: proc.stdout! })
  proc.once("exit", (code) => reject(new Error(`agent exited with code ${code}`)))
  rl.on("line", (line) => {
    const match = line.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (match) {
      rl.close()
      resolve(Number(match[1]))
    }
  })
})

const baseUrl = `http://127.0.0.1:${port}`
```

### Clean shutdown

Send `SIGTERM` (or `SIGINT`) on the parent. The wrapper bin forwards `SIGINT`, `SIGTERM`, and `SIGHUP` to the inner binary, which drains in-flight requests, emits the `runtime.closed` lifecycle event, and exits with status `0`. On Windows, killing the process tree (`taskkill /T`) works.

### Identity check after spawn

After the port is known, GET `/codefire/v1/manifest` and assert:

- `manifest.product.binary === "codefire-agent"`
- `manifest.runtime.mode === "terminal"` (no env triggers) or `"agent-chat"` (CodeFire context env present)
- `manifest.product.version` matches what you pinned

If this fails, the desktop is talking to the wrong process. Bail loudly.

---

## 4. Identity, modes, and what they mean

`CodeFire.detect()` resolves to one of three modes based on env vars and argv:

| Mode | Trigger | What changes |
| --- | --- | --- |
| `normal` | None of the triggers below | Acts as upstream `opencode`. Should not happen in your desktop integration unless something is misconfigured. |
| `terminal` | Binary name = `codefire-agent`, **or** `CODEFIRE_AGENT=1` | CodeFire-branded CLI (logo, command names, `productName()`); system prompts injected; isolated state dir; no auto-emit of lifecycle events (opt-in via `CODEFIRE_AGENT_LIFECYCLE`). |
| `agent-chat` | `CODEFIRE_AGENT_CHAT=1`, **or** `CODEFIRE_PROJECT_ID` set, **or** `CODEFIRE_PARENT_THREAD_ID` set | All of the above, plus: lifecycle events auto-emit, system prompts include project metadata, MCP handoff helpers are mentioned in the system prompt. |

The desktop should always spawn with `mode: "agent-chat"` when the spawn is on behalf of an in-app chat session. Set `CODEFIRE_PROJECT_ID` (the CodeFire project UUID) so the system prompt and MCP context line up.

`/codefire/v1/manifest.runtime` echoes the detected mode + IDs back to you for verification.

---

## 5. HTTP Control API

All endpoints are `GET`, return JSON with a top-level `schemaVersion: 1`, and require no auth (the server is loopback-only). Base path: `/codefire/v1/`.

| Endpoint | Purpose | Typical caller |
| --- | --- | --- |
| `GET /codefire/v1/manifest` | Identity, runtime, paths, declared capabilities. **Call once on startup to verify the right binary.** | Every host |
| `GET /codefire/v1/health` | `status: "ok"\|"degraded"\|"fail"` + per-check details. Cheap readiness probe. | Liveness watchdog |
| `GET /codefire/v1/models` | Available model catalog with provider grouping. | Settings UI ("choose model") |
| `GET /codefire/v1/settings` | Defaults + behavior knobs (model, agent, autoupdate, share mode) + paths. | Settings UI |
| `GET /codefire/v1/connections` | Per-provider auth readiness (env / stored credential / config). **Never returns secrets** — only boolean flags. | "Provider status" UI |
| `GET /codefire/v1/mcp` | CodeFire MCP configuration + connection status + diagnostic checks. | MCP setup UI, telemetry |
| `GET /codefire/v1/lifecycle` | The lifecycle event contract (event names, payload kind, sink location). Use this to discover whether file-based JSONL is active. | Lifecycle parser bootstrap |

### Payload reference

Use the TypeScript types in `@opencode-ai/sdk` (re-exported from `@opencode-ai/sdk/codefire` — see §6). The shapes:

#### `manifest`
```ts
{
  schemaVersion: 1
  product: {
    name: "CodeFire Terminal Agent"
    binary: "codefire-agent"
    version: string                  // e.g. "0.1.0-beta.3"
    channel: string                  // "beta", "latest", "local"
    engine: { name: "opencode", version: string }
  }
  runtime: {
    mode: "normal" | "terminal" | "agent-chat"
    cliName: "opencode" | "codefire-agent"
    projectID?: string
    parentThreadID?: number
    handoffTitle?: string
  }
  api: { version: "v1", basePath: "/codefire/v1", endpoints: string[] }
  paths: { home, data, config, state, cache, tmp, log, bin }  // all absolute
  capabilities: { controlApi, manifest, health, models, settings, connections, mcp, lifecycle }  // booleans
}
```

#### `health`
```ts
{
  schemaVersion: 1
  status: "ok" | "degraded" | "fail"
  time: string                       // ISO 8601
  runtime: <same shape as manifest.runtime>
  checks: Array<{ id: string, status: "pass"|"warn"|"fail", message: string }>
}
```

#### `models`
```ts
{
  schemaVersion: 1
  defaults: Record<string, string>   // e.g. { build: "anthropic/claude-...", plan: "..." }
  providers: Array<{
    id: string                       // "anthropic"
    name: string                     // "Anthropic"
    source: string                   // where the catalog came from
    modelCount: number
    models: Array<{
      id: string                     // "claude-opus-4-7"
      name: string                   // "Claude Opus 4.7"
      providerID: string
      status: string                 // "active" | "preview" | "deprecated" | ...
      context: number                // tokens
      output: number                 // tokens
    }>
  }>
}
```

#### `settings`
```ts
{
  schemaVersion: 1
  defaults: {
    model: string | null             // e.g. "anthropic/claude-opus-4-7"
    smallModel: string | null
    agent: string                    // "build" | "plan" | custom name
  }
  behavior: {
    autoupdate: boolean | "notify"
    share: "manual" | "auto" | "disabled"
  }
  paths: { config, data, state, cache }
}
```

Settings are **read-only** through this endpoint. To mutate, write to the agent's config file at `<paths.config>/config.json` (or the OS-appropriate equivalent) and have the desktop restart the sidecar, OR use the OpenCode v2 config API (not part of `/codefire/v1/*`).

#### `connections`
```ts
{
  schemaVersion: 1
  providers: Array<{
    id: string                       // "anthropic"
    name: string
    status: "available" | "connected"
    source: string
    auth: {
      env: boolean                   // an env var like ANTHROPIC_API_KEY is set
      stored: boolean                // credential is in the agent's auth store
      config: boolean                // provider has a config entry
    }
  }>
}
```

Never returns the credential value itself. Use this to drive a "your providers" UI showing which are connected and which need setup.

#### `mcp`
```ts
{
  schemaVersion: 1
  name: string                       // "codefire" (overridable)
  configured: boolean                // is an entry present in config.mcp[name]?
  enabled: boolean
  transport: "local" | "remote" | null
  status: "missing" | "disabled" | "uninitialized" | "connected" | "failed"
         | "needs_auth" | "needs_client_registration"
  toolCount: number | null           // null when status is not "connected"
  project: {
    id: string | null                // from CODEFIRE_PROJECT_ID
    parentThreadID: number | null
    mode: "normal" | "terminal" | "agent-chat"
  }
  checks: Array<{ status: "pass"|"warn"|"fail", label: string, detail: string }>
}
```

#### `lifecycle`
```ts
{
  schemaVersion: 1
  enabled: boolean                   // false if neither CODEFIRE_AGENT_CHAT nor CODEFIRE_AGENT_LIFECYCLE is set
  payload: { kind: "codefire.agent.lifecycle", version: 1 }
  sink:
    | { type: "file", path: string, format: "jsonl" }
    | { type: "stderr", prefix: string, format: "jsonl" }
  runtime: <same shape as manifest.runtime>
  events: Array<"runtime.started"|"session.ready"|"session.new"|"session.closed"|"runtime.closed">
}
```

### Error model

The control endpoints don't return application errors — they always succeed once the server is reachable. If the server is not reachable (port not listening, network issue), you'll get a transport-layer failure.

For other endpoints (OpenCode v2), use the regular `@opencode-ai/sdk` client which surfaces typed errors.

---

## 6. TypeScript SDK

The SDK ships in `@opencode-ai/sdk` and re-exports the CodeFire surface from `@opencode-ai/sdk/codefire`.

```ts
import { createCodeFireAgentClient } from "@opencode-ai/sdk/codefire"

const client = createCodeFireAgentClient({
  baseUrl: `http://127.0.0.1:${port}`,
  // optional: provide a custom fetcher (e.g. for tests or Electron's net module)
  // fetch: (input, init) => electronNet.fetch(input, init),
  // optional: extra headers
  // headers: { "x-desktop-build": process.env.npm_package_version },
})

// Discrete endpoints
const manifest    = await client.manifest()
const health      = await client.health()
const models      = await client.models()
const settings    = await client.settings()
const connections = await client.connections()
const mcp         = await client.mcp()
const lifecycle   = await client.lifecycle()

// Or fetch everything in parallel
const snapshot = await client.snapshot()
// → { manifest, health, models, settings, connections, mcp, lifecycle }
```

### Error handling

Non-2xx responses throw `CodeFireAgentClientError`:

```ts
import { CodeFireAgentClientError } from "@opencode-ai/sdk/codefire"

try {
  await client.manifest()
} catch (err) {
  if (err instanceof CodeFireAgentClientError) {
    console.error(`${err.path} → HTTP ${err.status}`, err.body)
  } else {
    // Network error, JSON parse error, etc.
    throw err
  }
}
```

### Types

Every payload has an exported TS type: `CodeFireManifest`, `CodeFireHealth`, `CodeFireModelCatalog`, `CodeFireSettings`, `CodeFireConnections`, `CodeFireMcp`, `CodeFireLifecycle`, and the union `CodeFireAgentSnapshot`. All extend an open `JsonObject` so the agent can add fields without breaking your client.

---

## 7. Lifecycle event stream

When `mode: "agent-chat"` (or `CODEFIRE_AGENT_LIFECYCLE=1`), the agent emits structured events as JSONL.

### Where they go

| `CODEFIRE_AGENT_LIFECYCLE_FILE` set? | Sink |
| --- | --- |
| Yes | Appended (UTF-8) to that file, one JSON object per line |
| No | Written to stderr, prefixed with `[codefire-agent] ` |

**Use the file sink for desktop integration.** Tailing a file is more reliable than parsing stderr across platforms.

### Event types

```ts
type LifecycleEvent =
  | "runtime.started"   // server is up; safe to make HTTP calls
  | "session.ready"     // the agent has a session ready to accept input
  | "session.new"       // a new session was created
  | "session.closed"    // a session ended
  | "runtime.closed"    // server is shutting down (final event)
```

### Payload shape

```ts
{
  kind: "codefire.agent.lifecycle"
  version: 1
  event: LifecycleEvent
  time: string                // ISO 8601
  runtime: {
    mode: "normal" | "terminal" | "agent-chat"
    cliName: "codefire-agent"
    projectID?: string
    parentThreadID?: number
    handoffTitle?: string
  }
  data: Record<string, unknown>   // event-specific (e.g. sessionID for session.* events)
}
```

### Consumer pattern (Node)

```ts
import { createInterface } from "node:readline"
import fs from "node:fs"

const stream = fs.createReadStream(lifecycleFile, { encoding: "utf8" })
const rl = createInterface({ input: stream })

rl.on("line", (line) => {
  if (!line.trim()) return
  let event: LifecyclePayload
  try { event = JSON.parse(line) } catch { return }
  if (event.kind !== "codefire.agent.lifecycle") return

  switch (event.event) {
    case "runtime.started": onAgentReady(); break
    case "session.ready":   onSessionReady(event.data.sessionID); break
    case "session.closed":  onSessionClosed(event.data.sessionID); break
    case "runtime.closed":  onAgentShutdown(); break
  }
})
```

For a long-running desktop, use a follow-style tail (`fs.watch` + offset tracking) rather than reading once on startup.

---

## 8. CodeFire MCP integration

The agent can connect to a CodeFire MCP server to get wiki/tasks/notes/context_search/etc. The config helper is `bootstrapConfig()` in `packages/opencode/src/codefire/mcp.ts`, and the runtime status is exposed at `GET /codefire/v1/mcp`.

### Default behavior (beta.5+)

When `CodeFire.active()` is true (any of the identity triggers from §4) and no `mcp.codefire` entry is present in the user config, the agent **auto-registers** an MCP entry at runtime. The command resolution is a smart two-tier fallback:

1. **If the external `codefire` binary is on PATH** (typically because the user has the CodeFire Desktop App installed), the entry points at the full-featured bridge:
   ```jsonc
   {
     "codefire": {
       "type": "local",
       "command": ["codefire", "mcp"],
       "enabled": true,
       "timeout": 30000,
       "environment": { "CODEFIRE_AGENT": "1", "CODEFIRE_PROJECT_ID": "<copied if set>", ... }
     }
   }
   ```
   This unlocks wiki pages, tasks, notes, semantic `context_search`, `agent_request_handoff`, etc.

2. **If the external bridge isn't found, the entry falls back to the bundled minimal MCP server** shipped inside the npm package itself:
   ```jsonc
   {
     "codefire": {
       "type": "local",
       "command": ["<process.execPath>", "mcp", "serve"],
       "enabled": true,
       "timeout": 30000,
       "environment": { "CODEFIRE_AGENT": "1", ... }
     }
   }
   ```
   The bundled server registers as `codefire-agent-bundled` and exposes a single `codefire_info` tool that explains how to enable the full feature set. This guarantees the agent always has *some* MCP entry that successfully connects — better than `status: "failed"` for standalone users.

Auto-register is **runtime-only** — the user's config file on disk is never touched. The injection is visible to the MCP runtime, to `/codefire/v1/mcp`, and to the in-agent system prompt.

**Explicit user config always wins.** If `mcp.codefire` is set (even to `enabled: false`), auto-register is a no-op.

### How the desktop app should provide the rich MCP bridge

When you ship the CodeFire Desktop App, place a `codefire` (or `codefire.exe` on Windows) binary on the user's PATH that, when invoked as `codefire mcp`, runs an stdio MCP server with the full feature set. The Terminal Agent auto-detects this on startup; no other coordination needed.

If the desktop spawns the agent itself (sidecar pattern), you can also point at your in-process MCP server directly:

```ts
env: {
  ...process.env,
  CODEFIRE_AGENT: "1",
  CODEFIRE_MCP_COMMAND: JSON.stringify([process.execPath, "/path/to/your/mcp-bridge.js"]),
}
```

This is the most reliable path — bypasses PATH resolution entirely.

### Overriding from the desktop

Three ways, in increasing specificity:

**(a) Env var at spawn time (recommended):**
```ts
const env = {
  ...process.env,
  CODEFIRE_AGENT: "1",
  // EITHER local command:
  CODEFIRE_MCP_COMMAND: JSON.stringify([process.execPath, "/path/to/codefire-mcp-bridge.js"]),
  // OR remote URL:
  // CODEFIRE_MCP_URL: "http://127.0.0.1:54321/mcp",
}
```

JSON-array form for the command is safer than shell-split form (no quoting surprises).

**(b) Write the agent's config file before spawning:**
```ts
import fs from "node:fs/promises"
import path from "node:path"

const configFile = path.join(agentHome, "config", "opencode", "config.json")
await fs.mkdir(path.dirname(configFile), { recursive: true })
await fs.writeFile(configFile, JSON.stringify({
  mcp: {
    codefire: {
      type: "local",
      command: [process.execPath, "/path/to/codefire-mcp-bridge.js"],
      enabled: true,
      timeout: 30000,
    },
  },
}))
```

**(c) Use a custom MCP server name:**
Set `CODEFIRE_MCP_NAME=cf-desktop` and the agent will look for that key in `config.mcp` instead of `codefire`.

### Checking MCP health

```ts
const mcp = await client.mcp()

if (mcp.status === "connected") {
  // green light
} else if (mcp.status === "missing") {
  // no MCP entry — desktop should configure one
} else if (mcp.status === "failed" || mcp.status === "needs_auth") {
  // surface the .checks[] details to the user
}
```

`mcp.checks` is a typed list of diagnostic results — show those verbatim in a "MCP setup" panel so users can self-diagnose.

---

## 9. Settings, models, and the OpenCode v2 chat surface

`/codefire/v1/*` is intentionally a *thin* read-only surface. For actual chat (creating sessions, sending messages, streaming tool calls), use the upstream **OpenCode v2** API exposed by the same HTTP server.

```ts
import { createOpencodeClient } from "@opencode-ai/sdk"

const openCode = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })

const session = await openCode.session.create({ /* ... */ })
const message = await openCode.session.message.send(session.id, { content: "..." })
```

Refer to `packages/opencode/src/server/routes/instance/httpapi/groups/v2/*` for endpoint specs and the `@opencode-ai/sdk` package for typed clients.

The desktop should treat the agent as the source of truth for sessions and messages — don't shadow that state in the desktop's own database; query it.

---

## 10. End-to-end example: minimal Electron main-process integration

```ts
// main.ts
import { spawn, ChildProcess } from "node:child_process"
import { createCodeFireAgentClient } from "@opencode-ai/sdk/codefire"
import { createOpencodeClient } from "@opencode-ai/sdk"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { app } from "electron"

let agent: ChildProcess | undefined
let baseUrl: string | undefined

export async function startAgent(projectID: string) {
  const agentHome = path.join(app.getPath("userData"), "codefire-agent")
  await fs.mkdir(agentHome, { recursive: true })

  const lifecycleFile = path.join(agentHome, "lifecycle.jsonl")
  await fs.writeFile(lifecycleFile, "") // truncate

  const agentBin = require.resolve("@codefireapp/agent/bin/codefire-agent")

  agent = spawn(process.execPath, [agentBin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: {
      ...process.env,
      CODEFIRE_AGENT: "1",
      CODEFIRE_AGENT_CHAT: "1",
      CODEFIRE_PROJECT_ID: projectID,
      CODEFIRE_AGENT_HOME: agentHome,
      CODEFIRE_AGENT_LIFECYCLE_FILE: lifecycleFile,
      // Wire your own MCP bridge:
      CODEFIRE_MCP_COMMAND: JSON.stringify([process.execPath, path.join(__dirname, "mcp-bridge.js")]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  agent.stderr?.on("data", (chunk) => console.warn("[agent]", chunk.toString()))
  agent.on("exit", (code) => { console.warn("agent exited", code); agent = undefined })

  // Wait for the port
  const port = await new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const m = chunk.toString().match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { agent!.stdout?.off("data", onData); resolve(Number(m[1])) }
    }
    agent!.stdout?.on("data", onData)
    agent!.once("exit", () => reject(new Error("agent died before listening")))
  })

  baseUrl = `http://127.0.0.1:${port}`

  // Verify identity
  const cf = createCodeFireAgentClient({ baseUrl })
  const manifest = await cf.manifest()
  if (manifest.product.binary !== "codefire-agent") {
    throw new Error(`unexpected binary: ${manifest.product.binary}`)
  }
  console.log(`agent ${manifest.product.version} (${manifest.product.channel}) ready at ${baseUrl}`)

  return { baseUrl, manifest }
}

export async function stopAgent() {
  if (!agent) return
  agent.kill("SIGTERM")
  await new Promise((resolve) => agent!.once("exit", resolve))
  agent = undefined
  baseUrl = undefined
}

export function openCode() {
  if (!baseUrl) throw new Error("agent not started")
  return createOpencodeClient({ baseUrl })
}

export function codefire() {
  if (!baseUrl) throw new Error("agent not started")
  return createCodeFireAgentClient({ baseUrl })
}

app.whenReady().then(() => startAgent("<your-project-id>"))
app.on("will-quit", stopAgent)
```

This gives you:
- A sidecar tied to the Electron app lifecycle
- Per-app state isolation under `userData/codefire-agent/`
- Project-scoped MCP context
- Typed access to both control API and OpenCode v2 chat

---

## 11. Common pitfalls

| Symptom | Cause | Fix |
| --- | --- | --- |
| Agent exits immediately with no error | Tried to spawn the wrapper bin directly on Windows | Use `process.execPath` (Node) to invoke the wrapper, OR set `OPENCODE_BIN_PATH` to the inner `opencode.exe`. The published wrapper is a Node script. |
| "Update Available v1.x.x" modal loops | Agent ≤ `0.1.0-beta.2` checking upstream opencode version | Upgrade to `0.1.0-beta.3+`. |
| MCP status stuck at `missing` | No `mcp.codefire` entry in config | Set `CODEFIRE_MCP_COMMAND` or `CODEFIRE_MCP_URL`, or write to `config.json` (see §8). |
| MCP status `failed` with `command is not executable from PATH` | `codefire` binary not on PATH where the agent runs | The desktop must provide the binary OR pass an absolute path via `CODEFIRE_MCP_COMMAND` JSON array. Don't rely on inherited PATH from the user's shell — Electron sub-processes have a minimal PATH on macOS. |
| `manifest.runtime.mode === "normal"` | None of the identity triggers were set | Pass `CODEFIRE_AGENT=1` (minimum) or `CODEFIRE_AGENT_CHAT=1` + `CODEFIRE_PROJECT_ID`. |
| Lifecycle events not arriving | `mode` is `terminal` and `CODEFIRE_AGENT_LIFECYCLE` is not set | Either spawn with `CODEFIRE_AGENT_CHAT=1` or set `CODEFIRE_AGENT_LIFECYCLE=1`. Then verify via `client.lifecycle()` that `enabled: true`. |
| Two `codefire-agent` processes after restart | Previous SIGTERM didn't reach the child | Use `tree-kill` on Windows, ensure `stdio: ["ignore", "pipe", "pipe"]` (not `inherit`), and listen for the `runtime.closed` lifecycle event before re-spawning. |
| Settings change in desktop not visible to agent | Agent caches config at startup | Restart the sidecar after writing the config file, OR (future) use the v2 config API to reload. |

---

## 12. Versioning + stability promises

- `/codefire/v1/*` is **stable** within `0.1.0-beta.*` — additive changes only (new fields, new endpoints). Breaking changes will bump to `/codefire/v2/*` and run side-by-side.
- The TS SDK types use open `JsonObject` extensions so adding fields to the JSON won't break consumer compiles.
- Lifecycle event payloads include `version: 1`. If we ever break the shape, you'll see a new version number; ignore or upgrade explicitly.
- The CLI command surface (`serve`, `run`, etc.) is **inherited from upstream OpenCode**. It can shift between minor versions. Pin a beta version and test before bumping.
- The npm package name `@codefireapp/agent` is **permanent**. The internal monorepo name (`opencode`) is **intentionally** not renamed to keep upstream merges cheap — see [[CodeFire Agent Harness]] wiki.

---

## 13. See also

- `README.md` — end-user install + run instructions
- `docs/codefire-agent-npm-deployment-runbook.md` — publish runbook
- `docs/codefire-terminal-agent-go-live.md` — verification checklist with evidence
- `packages/opencode/src/codefire/codefire.ts` — runtime detection
- `packages/opencode/src/codefire/lifecycle.ts` — lifecycle emitter
- `packages/opencode/src/codefire/mcp.ts` — MCP bootstrap config
- `packages/opencode/src/codefire/control.ts` — control API payload builders
- `packages/opencode/src/server/routes/instance/httpapi/handlers/codefire.ts` — HTTP handlers
- `packages/opencode/src/server/routes/instance/httpapi/groups/codefire.ts` — route + schema definitions
- `packages/sdk/js/src/codefire.ts` — SDK client + types
- Wiki: "CodeFire Agent Harness", "Distribution and Go-Live Plan", "NPM Publishing — @codefireapp/agent Process and Gotchas"
