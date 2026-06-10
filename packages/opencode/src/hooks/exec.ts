/**
 * Execution helpers for declarative config hooks (config `hooks` block).
 *
 * Hook commands are shell strings run with the worktree as cwd. Context is
 * passed twice: small values as OPENCODE_HOOK* environment variables, the
 * full event payload as JSON on stdin. This module is plain async (no
 * Effect) because it is consumed from the plugin layer, whose hooks are
 * plain async functions.
 */
import path from "path"
import { buffer } from "node:stream/consumers"
import { Process } from "@/util/process"
import { Wildcard } from "@/util/wildcard"

export const PRE_TOOL_TIMEOUT = 10_000
export const LIFECYCLE_TIMEOUT = 30_000
const STDERR_LIMIT = 2000

/** Tool-name filter; undefined matches every tool. Wildcards via Wildcard.match. */
export function matchesTool(filters: string[] | undefined, tool: string): boolean {
  if (!filters || filters.length === 0) return true
  return filters.some((filter) => Wildcard.match(tool, filter))
}

/**
 * File filter for file_edited hooks; matched against both the
 * worktree-relative path and basename so "*.ts" and "src/*.ts" both work.
 */
export function matchesGlob(glob: string | undefined, file: string, worktree: string): boolean {
  if (!glob) return true
  const relative = path.relative(worktree, file).replaceAll("\\", "/")
  return (
    Wildcard.match(relative, glob) ||
    Wildcard.match(path.basename(file), glob) ||
    Wildcard.match(file.replaceAll("\\", "/"), glob)
  )
}

/** The tool-error text shown to the model when a pre_tool hook blocks a call. */
export function blockMessage(command: string, code: number, stderr: string): string {
  const trimmed = stderr.trim()
  const detail = trimmed
    ? trimmed.length > STDERR_LIMIT
      ? trimmed.slice(0, STDERR_LIMIT) + "…"
      : trimmed
    : `hook exited with code ${code}`
  return `Blocked by pre_tool hook \`${command}\`: ${detail}`
}

/** Files written by a completed tool call, for file_edited dispatch. */
export function extractEditedFiles(tool: string, args: unknown, output: { metadata?: unknown }): string[] {
  if (tool === "edit" || tool === "write") {
    const filePath = (args as { filePath?: unknown })?.filePath
    return typeof filePath === "string" ? [filePath] : []
  }
  if (tool === "apply_patch") {
    const files = (output.metadata as { files?: { filePath?: unknown }[] })?.files
    if (!Array.isArray(files)) return []
    return files.map((file) => file.filePath).filter((file): file is string => typeof file === "string")
  }
  return []
}

export type ExecResult = { code: number; stderr: string } | { failed: string }

/**
 * Run one hook command. The deadline comes from an AbortSignal (the
 * Process.spawn `timeout` option is the SIGKILL grace period, not a
 * deadline). Spawn failures and timeouts resolve to `{failed}` so callers
 * can fail open.
 */
export async function execHook(input: {
  command: string
  cwd: string
  env: Record<string, string>
  payload: unknown
  timeout: number
}): Promise<ExecResult> {
  if (!input.command.trim()) return { failed: "empty hook command" }
  try {
    const proc = Process.spawn([input.command], {
      cwd: input.cwd,
      shell: true,
      env: input.env,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      abort: AbortSignal.timeout(input.timeout),
      timeout: 2000,
    })
    proc.stdin?.end(JSON.stringify(input.payload))
    const [code, stderr] = await Promise.all([proc.exited, buffer(proc.stderr!)])
    if (proc.killed && code !== 0) return { failed: `hook timed out after ${input.timeout}ms` }
    return { code, stderr: stderr.toString("utf8") }
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}
