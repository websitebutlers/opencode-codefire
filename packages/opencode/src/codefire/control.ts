import { Global } from "@opencode-ai/core/global"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import type { Auth } from "@/auth"
import type { Config } from "@/config/config"
import type { MCP } from "@/mcp"
import type { Provider } from "@/provider/provider"
import { CodeFire } from "./codefire"
import { CodeFireLifecycle } from "./lifecycle"
import { CodeFireMCP } from "./mcp"

type Env = Record<string, string | undefined>

function runtime(env: Env = process.env, argv = process.argv.slice(1)) {
  const detected = CodeFire.detect(argv, env)
  if (detected.mode !== "normal") return detected
  return CodeFire.detect(["codefire-agent"], env)
}

export function manifest(env: Env = process.env, argv = process.argv.slice(1)) {
  const active = runtime(env, argv)

  return {
    schemaVersion: 1 as const,
    product: {
      name: "CodeFire Terminal Agent",
      binary: "codefire-agent",
      version: InstallationVersion,
      channel: InstallationChannel,
      engine: {
        name: "opencode",
        version: InstallationVersion,
      },
    },
    runtime: active,
    api: {
      version: "v1",
      basePath: "/codefire/v1",
      endpoints: [
        "/codefire/v1/manifest",
        "/codefire/v1/health",
        "/codefire/v1/models",
        "/codefire/v1/settings",
        "/codefire/v1/connections",
        "/codefire/v1/mcp",
        "/codefire/v1/lifecycle",
      ],
    },
    paths: {
      home: Global.Path.home,
      data: Global.Path.data,
      config: Global.Path.config,
      state: Global.Path.state,
      cache: Global.Path.cache,
      tmp: Global.Path.tmp,
      log: Global.Path.log,
      bin: Global.Path.bin,
    },
    capabilities: {
      controlApi: true,
      manifest: true,
      health: true,
      models: true,
      settings: true,
      connections: true,
      mcp: true,
      lifecycle: true,
    },
  }
}

function sortedProviders(providers: Record<string, Provider.Info>) {
  return Object.values(providers).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function models(providers: Record<string, Provider.Info>, defaults: Record<string, string>) {
  return {
    schemaVersion: 1 as const,
    defaults,
    providers: sortedProviders(providers).map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      modelCount: Object.keys(provider.models).length,
      models: Object.values(provider.models)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((model) => ({
          id: model.id,
          name: model.name,
          providerID: model.providerID,
          status: model.status,
          context: model.limit.context,
          output: model.limit.output,
        })),
    })),
  }
}

export function settings(config: Config.Info) {
  return {
    schemaVersion: 1 as const,
    defaults: {
      model: config.model ?? null,
      smallModel: config.small_model ?? null,
      agent: config.default_agent ?? "build",
    },
    behavior: {
      autoupdate: config.autoupdate ?? true,
      share: config.share ?? "manual",
    },
    paths: {
      config: Global.Path.config,
      data: Global.Path.data,
      state: Global.Path.state,
      cache: Global.Path.cache,
    },
  }
}

export function connections(
  providers: Record<string, Provider.Info>,
  auth: Record<string, Auth.Info>,
  config: Config.Info,
  env: Env = process.env,
) {
  return {
    schemaVersion: 1 as const,
    providers: sortedProviders(providers).map((provider) => {
      const hasEnv = provider.env.some((key) => Boolean(env[key]))
      const hasStoredAuth = Boolean(auth[provider.id])
      const hasConfig = Boolean(config.provider?.[provider.id])
      return {
        id: provider.id,
        name: provider.name,
        status: hasEnv || hasStoredAuth || hasConfig ? ("connected" as const) : ("available" as const),
        source: provider.source,
        auth: {
          env: hasEnv,
          stored: hasStoredAuth,
          config: hasConfig,
        },
      }
    }),
  }
}

function mcpStatus(
  entry: ReturnType<typeof CodeFireMCP.configuredEntry>,
  status: MCP.Status | undefined,
): "missing" | "disabled" | "uninitialized" | MCP.Status["status"] {
  if (!entry) return "missing"
  if (entry.enabled === false) return "disabled"
  return status?.status ?? "uninitialized"
}

export function mcp(
  config: Pick<Config.Info, "mcp">,
  statuses: Record<string, MCP.Status>,
  toolCount: number | null,
  env: Env = process.env,
  argv = process.argv.slice(1),
) {
  const name = CodeFireMCP.mcpName(env)
  const augmentedMcp = CodeFireMCP.ensureAutoRegistered(config, {}, env, argv)
  const augmentedConfig: Pick<Config.Info, "mcp"> = { mcp: augmentedMcp }
  const entry = CodeFireMCP.configuredEntry(augmentedConfig, name)
  const active = runtime(env, argv)

  return {
    schemaVersion: 1 as const,
    name,
    configured: Boolean(entry),
    enabled: Boolean(entry && entry.enabled !== false),
    transport: entry ? entry.type : null,
    status: mcpStatus(entry, statuses[name]),
    toolCount,
    project: {
      id: active.projectID ?? null,
      parentThreadID: active.parentThreadID ?? null,
      mode: active.mode,
    },
    checks: CodeFireMCP.diagnostics(augmentedConfig, name, env),
  }
}

export function lifecycle(env: Env = process.env, argv = process.argv.slice(1)) {
  const file = env.CODEFIRE_AGENT_LIFECYCLE_FILE?.trim()

  return {
    schemaVersion: 1 as const,
    enabled: CodeFireLifecycle.shouldEmit(env, argv),
    payload: {
      kind: "codefire.agent.lifecycle" as const,
      version: 1 as const,
    },
    sink: file
      ? {
          type: "file" as const,
          path: file,
          format: "jsonl" as const,
        }
      : {
          type: "stderr" as const,
          prefix: "[codefire-agent]",
          format: "jsonl" as const,
        },
    runtime: runtime(env, argv),
    events: CodeFireLifecycle.events,
  }
}

export function health(env: Env = process.env, argv = process.argv.slice(1), now = new Date()) {
  const active = runtime(env, argv)

  return {
    schemaVersion: 1 as const,
    status: "ok" as const,
    time: now.toISOString(),
    runtime: active,
    checks: [
      {
        id: "runtime",
        status: "pass" as const,
        message: `CodeFire ${active.mode === "agent-chat" ? "agent chat" : "terminal agent"} runtime is active`,
      },
      {
        id: "control-api",
        status: "pass" as const,
        message: "CodeFire control API is available",
      },
      {
        id: "lifecycle",
        status: "pass" as const,
        message: CodeFireLifecycle.shouldEmit(env, argv)
          ? "Lifecycle events are enabled"
          : "Lifecycle events are available",
      },
    ],
  }
}

export const CodeFireControl = {
  connections,
  health,
  lifecycle,
  manifest,
  mcp,
  models,
  settings,
}
