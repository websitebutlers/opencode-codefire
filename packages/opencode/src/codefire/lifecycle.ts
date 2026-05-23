import fs from "fs/promises"
import { CodeFire } from "./codefire"

type Env = Record<string, string | undefined>

type Runtime = ReturnType<typeof CodeFire.detect>

export type LifecycleEvent =
  | "runtime.started"
  | "session.ready"
  | "session.new"
  | "session.closed"
  | "runtime.closed"

export type LifecyclePayload = {
  kind: "codefire.agent.lifecycle"
  version: 1
  event: LifecycleEvent
  time: string
  runtime: Runtime
  data: Record<string, unknown>
}

function enabled(value: string | undefined) {
  if (!value) return false
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase())
}

export function shouldEmit(env: Env = process.env, argv = process.argv.slice(1)) {
  const runtime = CodeFire.detect(argv, env)
  return runtime.mode === "agent-chat" || enabled(env.CODEFIRE_AGENT_LIFECYCLE)
}

export function payload(
  event: LifecycleEvent,
  data: Record<string, unknown> = {},
  env: Env = process.env,
  argv = process.argv.slice(1),
  now = new Date(),
): LifecyclePayload {
  return {
    kind: "codefire.agent.lifecycle",
    version: 1,
    event,
    time: now.toISOString(),
    runtime: CodeFire.detect(argv, env),
    data,
  }
}

export async function emit(
  event: LifecycleEvent,
  data: Record<string, unknown> = {},
  env: Env = process.env,
  argv = process.argv.slice(1),
) {
  if (!shouldEmit(env, argv)) return

  const line = JSON.stringify(payload(event, data, env, argv)) + "\n"
  const file = env.CODEFIRE_AGENT_LIFECYCLE_FILE?.trim()
  if (file) {
    await fs.appendFile(file, line)
    return
  }

  process.stderr.write(`[codefire-agent] ${line}`)
}

export const CodeFireLifecycle = {
  emit,
  payload,
  shouldEmit,
}
