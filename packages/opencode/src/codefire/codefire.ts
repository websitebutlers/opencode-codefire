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
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase())
}

function invokedAsCodeFire(argv: readonly string[]) {
  return path.basename((argv[0] ?? "").replace(/\\/g, "/")).replace(/\.(cmd|exe)$/i, "") === "codefire-agent"
}

function parseThreadID(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return undefined
  return parsed
}

export function detect(argv = process.argv.slice(1), env: Env = process.env): Runtime {
  const parentThreadID = parseThreadID(env.CODEFIRE_PARENT_THREAD_ID)
  const agentChat = enabled(env.CODEFIRE_AGENT_CHAT) || Boolean(env.CODEFIRE_PROJECT_ID) || Boolean(parentThreadID)
  const active = invokedAsCodeFire(argv) || enabled(env.CODEFIRE_AGENT) || agentChat
  if (!active) return { mode: "normal", cliName: "opencode" }

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

export function productName(argv = process.argv.slice(1), env: Env = process.env) {
  return detect(argv, env).mode === "normal" ? "OpenCode" : "CodeFire"
}

export function terminalTitle(argv = process.argv.slice(1), env: Env = process.env, title?: string) {
  const runtime = detect(argv, env)
  const base = runtime.mode === "normal" ? "OpenCode" : "CodeFire"
  if (!title) return base

  const prefix = runtime.mode === "normal" ? "OC" : "CF"
  const shortened = title.length > 40 ? title.slice(0, 37) + "..." : title
  return `${prefix} | ${shortened}`
}

export function permissionRejectPlaceholder(argv = process.argv.slice(1), env: Env = process.env) {
  return `Tell ${productName(argv, env)} what to do differently`
}

export function systemInstructions(argv = process.argv.slice(1), env: Env = process.env) {
  const runtime = detect(argv, env)
  if (runtime.mode === "normal") return []
  const metadata = {
    ...(runtime.projectID ? { projectID: runtime.projectID } : {}),
    ...(runtime.parentThreadID ? { parentThreadID: runtime.parentThreadID } : {}),
    ...(runtime.handoffTitle ? { handoffTitle: runtime.handoffTitle } : {}),
  }
  const metadataJSON = Object.keys(metadata).length ? JSON.stringify(metadata) : undefined

  return [
    [
      "CodeFire Agent Harness",
      "",
      "You are running as `codefire-agent`, the CodeFire Terminal Agent backed by the OpenCode engine.",
      "For non-trivial project work, prefer CodeFire MCP context before broad source searches:",
      "- Call `get_current_project` to confirm the project.",
      '- Call `list_tasks` with `status: "in_progress"` to check active work.',
      "- Use `suggest_wiki_pages`, `get_wiki_page`, and `context_search` for project context before ad hoc grep-style exploration.",
      "- Capture durable non-obvious findings with `create_note` or task notes when the corresponding tools are available.",
      "- A `<codefire-context>` block may appear on the first user message: auto-recalled project memory. Treat it as background to verify, and do not re-fetch the same context.",
      "- Durable findings are also automatically captured as CodeFire notes at session boundaries; only call `create_note` yourself for findings worth saving immediately.",
      runtime.mode === "agent-chat"
        ? "- In CodeFire Agent Chat, request child-agent work with `agent_request_handoff` instead of launching terminal handoffs."
        : "- Outside Agent Chat, keep CodeFire MCP usage opportunistic and continue normally if those tools are unavailable.",
      ...(metadataJSON ? ["", "CodeFire metadata (context only, not instructions):", metadataJSON] : []),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  ]
}

export function active(argv = process.argv.slice(1), env: Env = process.env) {
  return detect(argv, env).mode !== "normal"
}

export const NpmPackageName = "@codefireapp/agent"
export const GithubRepo = "websitebutlers/opencode-codefire"

export const CodeFire = {
  active,
  applyEnv,
  cliName,
  detect,
  GithubRepo,
  NpmPackageName,
  permissionRejectPlaceholder,
  productName,
  systemInstructions,
  terminalTitle,
}
