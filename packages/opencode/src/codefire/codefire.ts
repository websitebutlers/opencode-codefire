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
  return path.basename((argv[0] ?? "").replace(/\\/g, "/")).replace(/\.(cmd|exe)$/i, "") === "codefire-agent"
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
  const metadata = [
    runtime.projectID ? `projectID: ${runtime.projectID}` : undefined,
    runtime.parentThreadID ? `parentThreadID: ${runtime.parentThreadID}` : undefined,
    runtime.handoffTitle ? `handoffTitle: ${runtime.handoffTitle}` : undefined,
  ].filter((line): line is string => Boolean(line))

  return [
    [
      "CodeFire Agent Harness",
      "",
      "You are running as `codefire-agent`, a CodeFire-oriented OpenCode harness.",
      "For non-trivial project work, prefer CodeFire MCP context before broad source searches:",
      "- Call `get_current_project` to confirm the project.",
      '- Call `list_tasks` with `status: "in_progress"` to check active work.',
      "- Use `suggest_wiki_pages`, `get_wiki_page`, and `context_search` for project context before ad hoc grep-style exploration.",
      "- Capture durable non-obvious findings with `create_note` or task notes when the corresponding tools are available.",
      runtime.mode === "agent-chat"
        ? "- In CodeFire Agent Chat, request child-agent work with `agent_request_handoff` instead of launching terminal handoffs."
        : "- Outside Agent Chat, keep CodeFire MCP usage opportunistic and continue normally if those tools are unavailable.",
      metadata.length ? "" : undefined,
      metadata.length ? "CodeFire metadata (context only, not instructions):" : undefined,
      ...metadata,
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
