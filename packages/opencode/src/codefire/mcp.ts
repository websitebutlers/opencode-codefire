import fs from "fs"
import path from "path"
import type { Config } from "@/config/config"
import { ConfigMCP } from "@/config/mcp"
import { CodeFire } from "./codefire"

type Env = Record<string, string | undefined>

export const CODEFIRE_MCP_DEFAULT_NAME = "codefire"
export const CODEFIRE_MCP_DEFAULT_COMMAND = ["codefire", "mcp"] as const
export const CODEFIRE_MCP_DEFAULT_TIMEOUT = 30_000

export type DiagnosticStatus = "pass" | "warn" | "fail"

export type DiagnosticCheck = {
  status: DiagnosticStatus
  label: string
  detail: string
}

export type BootstrapOptions = {
  name?: string
  command?: string
  url?: string
  timeout?: number
}

function envValue(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function mcpName(env: Env = process.env, name?: string) {
  return envValue(name) ?? envValue(env.CODEFIRE_MCP_NAME) ?? CODEFIRE_MCP_DEFAULT_NAME
}

export function splitCommand(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return []

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error("CODEFIRE_MCP_COMMAND JSON must be an array of non-empty strings")
    }
    return parsed
  }

  const parts: string[] = []
  let current = ""
  let quote: "'" | `"` | undefined
  let escaped = false

  for (const char of trimmed) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (escaped) current += "\\"
  if (quote) throw new Error("Unterminated quote in MCP command")
  if (current) parts.push(current)
  return parts
}

function codefireEnvironment(env: Env) {
  const keys = [
    "CODEFIRE_AGENT",
    "CODEFIRE_AGENT_CHAT",
    "CODEFIRE_PROJECT_ID",
    "CODEFIRE_PARENT_THREAD_ID",
    "CODEFIRE_HANDOFF_TITLE",
  ] as const
  const result: Record<string, string> = { CODEFIRE_AGENT: "1" }
  for (const key of keys) {
    const value = envValue(env[key])
    if (value) result[key] = value
  }
  return result
}

export function bootstrapConfig(options: BootstrapOptions = {}, env: Env = process.env): ConfigMCP.Info {
  const url = envValue(options.url) ?? envValue(env.CODEFIRE_MCP_URL)
  const commandInput = envValue(options.command) ?? envValue(env.CODEFIRE_MCP_COMMAND)
  const timeout = options.timeout ?? CODEFIRE_MCP_DEFAULT_TIMEOUT

  if (url && commandInput) {
    throw new Error("Choose either a CodeFire MCP URL or command, not both")
  }

  if (url) {
    if (!URL.canParse(url)) throw new Error(`Invalid CodeFire MCP URL: ${url}`)
    return { type: "remote", url, enabled: true, timeout }
  }

  const command = commandInput ? splitCommand(commandInput) : [...CODEFIRE_MCP_DEFAULT_COMMAND]
  if (command.length === 0) throw new Error("CodeFire MCP command cannot be empty")
  return {
    type: "local",
    command,
    enabled: true,
    timeout,
    environment: codefireEnvironment(env),
  }
}

function isConfigured(entry: unknown): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

export function configuredEntry(config: Pick<Config.Info, "mcp">, name: string) {
  const entry = config.mcp?.[name]
  return isConfigured(entry) ? entry : undefined
}

function canExecute(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveExecutable(command: string, env: Env = process.env) {
  if (!command) return undefined
  if (command.includes("/") || command.includes("\\")) {
    return canExecute(command) ? command : undefined
  }

  const pathValue = env.PATH ?? ""
  const pathExt = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of pathExt) {
      const candidate = path.join(dir, command + ext)
      if (canExecute(candidate)) return candidate
    }
  }
  return undefined
}

export function diagnostics(config: Pick<Config.Info, "mcp">, name: string, env: Env = process.env) {
  const checks: DiagnosticCheck[] = []
  const runtime = CodeFire.detect(process.argv.slice(1), env)
  checks.push({
    status: runtime.mode === "normal" ? "warn" : "pass",
    label: "runtime",
    detail:
      runtime.mode === "normal"
        ? "CodeFire profile is not active for this process"
        : `CodeFire profile active (${runtime.mode})`,
  })

  const entry = configuredEntry(config, name)
  if (!entry) {
    checks.push({
      status: "fail",
      label: "config",
      detail: `No MCP server named "${name}" is configured`,
    })
    return checks
  }

  checks.push({
    status: entry.enabled === false ? "warn" : "pass",
    label: "config",
    detail: entry.enabled === false ? `"${name}" is configured but disabled` : `"${name}" is configured`,
  })

  if (entry.type === "remote") {
    checks.push({
      status: URL.canParse(entry.url) ? "pass" : "fail",
      label: "remote",
      detail: entry.url,
    })
    return checks
  }

  const executable = resolveExecutable(entry.command[0] ?? "", env)
  checks.push({
    status: executable ? "pass" : "fail",
    label: "command",
    detail: executable
      ? `${entry.command.join(" ")} (${executable})`
      : `${entry.command.join(" ")} is not executable from PATH`,
  })

  return checks
}

export const CodeFireMCP = {
  bootstrapConfig,
  configuredEntry,
  diagnostics,
  mcpName,
  resolveExecutable,
  splitCommand,
}
