# CodeFire Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `codefire-agent` CLI alias that runs OpenCode with CodeFire-oriented startup context in Agent Chat and standalone terminal modes.

**Architecture:** Keep OpenCode as the execution engine. Add a focused `packages/opencode/src/codefire/` adapter that detects CodeFire launch mode, formats deterministic system instructions, and is consumed by the CLI bootstrap and session prompt assembly.

**Tech Stack:** Bun, TypeScript, yargs, Effect-based OpenCode services, Bun test.

---

## File Structure

- Create `packages/opencode/src/codefire/codefire.ts`
  - Pure helper module for CodeFire launch detection, Agent Chat metadata parsing, CLI name selection, and generated system instructions.
- Create `packages/opencode/test/codefire/codefire.test.ts`
  - Unit tests for the pure CodeFire helper module.
- Modify `packages/opencode/package.json`
  - Add the `codefire-agent` bin alias beside the existing `opencode` bin.
- Modify `packages/opencode/bin/opencode`
  - Preserve `codefire-agent` invocation by setting `CODEFIRE_AGENT=1` before spawning the compiled binary.
- Modify `packages/opencode/src/index.ts`
  - Import the CodeFire adapter, set the CodeFire profile flag during source/dev execution, and use `codefire-agent` as the yargs script name when applicable.
- Modify `packages/opencode/src/session/prompt.ts`
  - Append CodeFire system instructions during system prompt assembly when CodeFire mode is active.

## Task 1: CodeFire Runtime Adapter

**Files:**
- Create: `packages/opencode/src/codefire/codefire.ts`
- Create: `packages/opencode/test/codefire/codefire.test.ts`

- [ ] **Step 1: Write the failing adapter tests**

Create `packages/opencode/test/codefire/codefire.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CodeFire } from "@/codefire/codefire"

describe("CodeFire", () => {
  test("does not enable CodeFire mode for normal opencode launches", () => {
    expect(CodeFire.detect(["/usr/local/bin/opencode"], {}).mode).toBe("normal")
    expect(CodeFire.systemInstructions(["/usr/local/bin/opencode"], {})).toEqual([])
  })

  test("detects the codefire-agent binary name", () => {
    const runtime = CodeFire.detect(["/usr/local/bin/codefire-agent"], {})
    expect(runtime.mode).toBe("terminal")
    expect(runtime.cliName).toBe("codefire-agent")
  })

  test("detects explicit CodeFire profile env", () => {
    const runtime = CodeFire.detect(["/usr/local/bin/opencode"], { CODEFIRE_AGENT: "1" })
    expect(runtime.mode).toBe("terminal")
    expect(runtime.cliName).toBe("codefire-agent")
  })

  test("detects Agent Chat mode from CodeFire metadata", () => {
    const runtime = CodeFire.detect(["/usr/local/bin/opencode"], {
      CODEFIRE_AGENT: "1",
      CODEFIRE_AGENT_CHAT: "1",
      CODEFIRE_PROJECT_ID: "43b39618-0636-4cd6-ac25-23e7798392fc",
      CODEFIRE_PARENT_THREAD_ID: "150",
      CODEFIRE_HANDOFF_TITLE: "Build CodeFire agent harness",
    })

    expect(runtime.mode).toBe("agent-chat")
    expect(runtime.projectID).toBe("43b39618-0636-4cd6-ac25-23e7798392fc")
    expect(runtime.parentThreadID).toBe(150)
    expect(runtime.handoffTitle).toBe("Build CodeFire agent harness")
  })

  test("includes CodeFire MCP orientation in generated system instructions", () => {
    const instructions = CodeFire.systemInstructions(["/usr/local/bin/codefire-agent"], {
      CODEFIRE_PROJECT_ID: "project-1",
      CODEFIRE_PARENT_THREAD_ID: "150",
    })

    expect(instructions).toHaveLength(1)
    expect(instructions[0]).toContain("CodeFire Agent Harness")
    expect(instructions[0]).toContain("get_current_project")
    expect(instructions[0]).toContain("context_search")
    expect(instructions[0]).toContain("agent_request_handoff")
    expect(instructions[0]).toContain("project-1")
    expect(instructions[0]).toContain("150")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/opencode
bun test test/codefire/codefire.test.ts
```

Expected: FAIL because `@/codefire/codefire` does not exist.

- [ ] **Step 3: Implement the adapter**

Create `packages/opencode/src/codefire/codefire.ts`:

```ts
import path from "path"

type Env = Record<string, string | undefined>

export type Runtime = {
  mode: "normal" | "terminal" | "agent-chat"
  cliName: "opencode" | "codefire-agent"
  projectID?: string
  parentThreadID?: number
  handoffTitle?: string
}

function enabled(value: string | undefined) {
  if (!value) return false
  return !["0", "false", "off", "no"].includes(value.toLowerCase())
}

function invokedAsCodeFire(argv: readonly string[]) {
  return path.basename(argv[0] ?? "").replace(/\.cmd$/i, "") === "codefire-agent"
}

function parseThreadID(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return undefined
  return parsed
}

export function detect(argv = process.argv.slice(1), env: Env = process.env): Runtime {
  const active = invokedAsCodeFire(argv) || enabled(env.CODEFIRE_AGENT)
  if (!active) return { mode: "normal", cliName: "opencode" }

  const parentThreadID = parseThreadID(env.CODEFIRE_PARENT_THREAD_ID)
  const agentChat = enabled(env.CODEFIRE_AGENT_CHAT) || Boolean(env.CODEFIRE_PROJECT_ID) || Boolean(parentThreadID)

  return {
    mode: agentChat ? "agent-chat" : "terminal",
    cliName: "codefire-agent",
    projectID: env.CODEFIRE_PROJECT_ID,
    parentThreadID,
    handoffTitle: env.CODEFIRE_HANDOFF_TITLE,
  }
}

export function applyEnv(argv = process.argv.slice(1), env = process.env) {
  if (detect(argv, env).mode === "normal") return
  env.CODEFIRE_AGENT = "1"
}

export function cliName(argv = process.argv.slice(1), env: Env = process.env) {
  return detect(argv, env).cliName
}

export function systemInstructions(argv = process.argv.slice(1), env: Env = process.env) {
  const runtime = detect(argv, env)
  if (runtime.mode === "normal") return []

  return [
    [
      "CodeFire Agent Harness",
      "",
      "You are running as `codefire-agent`, a CodeFire-oriented OpenCode harness.",
      "For non-trivial project work, prefer CodeFire MCP context before broad source searches:",
      "- Call `get_current_project` to confirm the project.",
      "- Call `list_tasks` with `status: \"in_progress\"` to check active work.",
      "- Use `suggest_wiki_pages`, `get_wiki_page`, and `context_search` for project context before ad hoc grep-style exploration.",
      "- Capture durable non-obvious findings with `create_note` or task notes when the corresponding tools are available.",
      runtime.mode === "agent-chat"
        ? "- In CodeFire Agent Chat, request child-agent work with `agent_request_handoff` instead of launching terminal handoffs."
        : "- Outside Agent Chat, keep CodeFire MCP usage opportunistic and continue normally if those tools are unavailable.",
      runtime.projectID ? `CodeFire project id: ${runtime.projectID}` : undefined,
      runtime.parentThreadID ? `CodeFire parent thread id: ${runtime.parentThreadID}` : undefined,
      runtime.handoffTitle ? `CodeFire handoff title: ${runtime.handoffTitle}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  ]
}

export const CodeFire = {
  applyEnv,
  cliName,
  detect,
  systemInstructions,
}
```

- [ ] **Step 4: Run the adapter test to verify it passes**

Run:

```bash
cd packages/opencode
bun test test/codefire/codefire.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the adapter**

```bash
git add packages/opencode/src/codefire/codefire.ts packages/opencode/test/codefire/codefire.test.ts
git commit -m "feat(opencode): add codefire runtime adapter"
```

## Task 2: Binary Alias And Wrapper Propagation

**Files:**
- Modify: `packages/opencode/package.json`
- Modify: `packages/opencode/bin/opencode`
- Create: `packages/opencode/test/codefire/bin.test.ts`

- [ ] **Step 1: Write the failing bin alias tests**

Create `packages/opencode/test/codefire/bin.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import path from "path"

describe("codefire-agent bin alias", () => {
  test("package.json exposes codefire-agent beside opencode", async () => {
    const pkg = await Bun.file(path.join(import.meta.dir, "../../package.json")).json()
    expect(pkg.bin.opencode).toBe("./bin/opencode")
    expect(pkg.bin["codefire-agent"]).toBe("./bin/opencode")
  })

  test("node wrapper preserves codefire-agent invocation", async () => {
    const wrapper = await Bun.file(path.join(import.meta.dir, "../../bin/opencode")).text()
    expect(wrapper).toContain('path.basename(process.argv[1] || "")')
    expect(wrapper).toContain('process.env.CODEFIRE_AGENT = "1"')
  })
})
```

- [ ] **Step 2: Run the bin alias test to verify it fails**

Run:

```bash
cd packages/opencode
bun test test/codefire/bin.test.ts
```

Expected: FAIL because `codefire-agent` is not in `bin`, and the wrapper does not set `CODEFIRE_AGENT`.

- [ ] **Step 3: Add the package bin alias**

Change `packages/opencode/package.json` from:

```json
"bin": {
  "opencode": "./bin/opencode"
},
```

to:

```json
"bin": {
  "opencode": "./bin/opencode",
  "codefire-agent": "./bin/opencode"
},
```

- [ ] **Step 4: Preserve the alias in the node wrapper**

In `packages/opencode/bin/opencode`, add this immediately before `const envPath = process.env.OPENCODE_BIN_PATH`:

```js
const invokedName = path.basename(process.argv[1] || "")
if (invokedName === "codefire-agent") {
  process.env.CODEFIRE_AGENT = "1"
}
```

- [ ] **Step 5: Run the bin alias test to verify it passes**

Run:

```bash
cd packages/opencode
bun test test/codefire/bin.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the alias**

```bash
git add packages/opencode/package.json packages/opencode/bin/opencode packages/opencode/test/codefire/bin.test.ts
git commit -m "feat(opencode): add codefire-agent bin alias"
```

## Task 3: CLI Bootstrap Identity

**Files:**
- Modify: `packages/opencode/src/index.ts`

- [ ] **Step 1: Write the failing test**

Extend `packages/opencode/test/codefire/codefire.test.ts` with:

```ts
test("sets cli name to codefire-agent when env profile is active", () => {
  expect(CodeFire.cliName(["/usr/local/bin/opencode"], { CODEFIRE_AGENT: "1" })).toBe("codefire-agent")
})
```

- [ ] **Step 2: Run the test to verify it passes before integration**

Run:

```bash
cd packages/opencode
bun test test/codefire/codefire.test.ts
```

Expected: PASS. This confirms the helper is ready before wiring it into the CLI.

- [ ] **Step 3: Wire the helper into the CLI bootstrap**

In `packages/opencode/src/index.ts`, add this import:

```ts
import { CodeFire } from "@/codefire/codefire"
```

After `const args = hideBin(process.argv)`, add:

```ts
CodeFire.applyEnv()
const scriptName = CodeFire.cliName()
```

Change:

```ts
.scriptName("opencode")
```

to:

```ts
.scriptName(scriptName)
```

- [ ] **Step 4: Run the focused CodeFire tests**

Run:

```bash
cd packages/opencode
bun test test/codefire/codefire.test.ts test/codefire/bin.test.ts test/codefire/prompt-integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Smoke check help identity**

Run:

```bash
cd packages/opencode
CODEFIRE_AGENT=1 bun run --conditions=browser ./src/index.ts --help
```

Expected: help output begins with `codefire-agent`, not `opencode`.

- [ ] **Step 6: Commit the bootstrap integration**

```bash
git add packages/opencode/src/index.ts packages/opencode/test/codefire/codefire.test.ts
git commit -m "feat(opencode): use codefire cli identity"
```

## Task 4: System Prompt Injection

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts`
- Create: `packages/opencode/test/codefire/prompt-integration.test.ts`

- [ ] **Step 1: Write the focused system-instruction assertion**

Create `packages/opencode/test/codefire/prompt-integration.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import path from "path"

describe("CodeFire prompt integration", () => {
  test("session prompt assembly includes CodeFire system instructions", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/session/prompt.ts")).text()
    expect(source).toContain('import { CodeFire } from "@/codefire/codefire"')
    expect(source).toContain("CodeFire.systemInstructions()")
    expect(source).toContain("...CodeFire.systemInstructions()")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/opencode
bun test test/codefire/prompt-integration.test.ts
```

Expected: FAIL because `session/prompt.ts` does not import or call the CodeFire adapter yet.

- [ ] **Step 3: Inject CodeFire instructions into session prompt assembly**

In `packages/opencode/src/session/prompt.ts`, add this import:

```ts
import { CodeFire } from "@/codefire/codefire"
```

Find the system assembly near `instruction.system()`:

```ts
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
])
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
```

Change it to:

```ts
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
])
const system = [...env, ...CodeFire.systemInstructions(), ...instructions, ...(skills ? [skills] : [])]
```

- [ ] **Step 4: Run focused CodeFire tests**

Run:

```bash
cd packages/opencode
bun test test/codefire/codefire.test.ts test/codefire/prompt-integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the prompt integration**

```bash
git add packages/opencode/src/session/prompt.ts packages/opencode/test/codefire/prompt-integration.test.ts
git commit -m "feat(opencode): inject codefire system instructions"
```

## Task 5: Package Verification

**Files:**
- No source edits expected unless verification exposes issues.

- [ ] **Step 1: Run targeted CodeFire tests**

Run:

```bash
cd packages/opencode
bun test test/codefire/codefire.test.ts test/codefire/bin.test.ts test/codefire/prompt-integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
cd packages/opencode
bun typecheck
```

Expected: PASS.

- [ ] **Step 3: Smoke check normal CLI identity**

Run:

```bash
cd packages/opencode
bun run --conditions=browser ./src/index.ts --help
```

Expected: help output begins with `opencode`, not `codefire-agent`.

- [ ] **Step 4: Smoke check CodeFire CLI identity**

Run:

```bash
cd packages/opencode
CODEFIRE_AGENT=1 bun run --conditions=browser ./src/index.ts --help
```

Expected: help output begins with `codefire-agent`, not `opencode`.

- [ ] **Step 5: Commit any verification fixes**

If verification required fixes:

```bash
git add packages/opencode
git commit -m "fix(opencode): stabilize codefire harness verification"
```

If no fixes were required, do not create an empty commit.

## Plan Self-Review

- Spec coverage: The plan covers the `codefire-agent` alias, CodeFire runtime adapter, Agent Chat metadata detection, MCP-first system instructions, standalone fallback, and package-local verification.
- Marker scan: No reserved unfinished-work markers or open-ended implementation gaps remain.
- Type consistency: The plan consistently uses `CodeFire.detect`, `CodeFire.applyEnv`, `CodeFire.cliName`, and `CodeFire.systemInstructions` from `@/codefire/codefire`.
