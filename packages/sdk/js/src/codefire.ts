type JsonObject = Record<string, unknown>

export type CodeFireRuntime = {
  mode: "normal" | "terminal" | "agent-chat"
  cliName?: "opencode" | "codefire-agent"
  projectID?: string
  parentThreadID?: number
  handoffTitle?: string
} & JsonObject

export type CodeFireManifest = {
  schemaVersion: 1
  product: {
    name: string
    binary: string
    version?: string
    channel?: string
    engine?: {
      name: string
      version?: string
    } & JsonObject
  } & JsonObject
  runtime?: CodeFireRuntime
  api: {
    version?: string
    basePath: string
    endpoints?: string[]
  } & JsonObject
  capabilities?: Record<string, boolean>
  paths?: Record<string, string>
} & JsonObject

export type CodeFireHealth = {
  schemaVersion: 1
  status: "ok" | "degraded" | "fail"
  time?: string
  runtime?: CodeFireRuntime
  checks?: Array<{
    id: string
    status: "pass" | "warn" | "fail"
    message: string
  }>
} & JsonObject

export type CodeFireModelCatalog = {
  schemaVersion: 1
  defaults: Record<string, string>
  providers: Array<{
    id: string
    name: string
    source: string
    modelCount: number
    models: Array<{
      id: string
      name: string
      providerID: string
      status: string
      context: number
      output: number
    }>
  }>
} & JsonObject

export type CodeFireSettings = {
  schemaVersion: 1
  defaults: {
    model: string | null
    smallModel: string | null
    agent: string
  } & JsonObject
  behavior: {
    autoupdate: boolean | "notify"
    share: "manual" | "auto" | "disabled"
  } & JsonObject
  paths: Record<string, string>
} & JsonObject

export type CodeFireConnection = {
  id: string
  name: string
  status: "available" | "connected"
  source: string
  auth: {
    env: boolean
    stored: boolean
    config: boolean
  }
} & JsonObject

export type CodeFireConnections = {
  schemaVersion: 1
  providers: CodeFireConnection[]
} & JsonObject

export type CodeFireMcp = {
  schemaVersion: 1
  name: string
  configured: boolean
  enabled: boolean
  transport: "local" | "remote" | null
  status: "missing" | "disabled" | "uninitialized" | "connected" | "failed" | "needs_auth" | "needs_client_registration"
  toolCount: number | null
  project: {
    id: string | null
    parentThreadID: number | null
    mode: "normal" | "terminal" | "agent-chat"
  } & JsonObject
  checks: Array<{
    status: "pass" | "warn" | "fail"
    label: string
    detail: string
  }>
} & JsonObject

export type CodeFireLifecycle = {
  schemaVersion: 1
  enabled: boolean
  payload: {
    kind: "codefire.agent.lifecycle"
    version: 1
  } & JsonObject
  sink:
    | ({
        type: "file"
        path: string
        format: "jsonl"
      } & JsonObject)
    | ({
        type: "stderr"
        prefix: string
        format: "jsonl"
      } & JsonObject)
  runtime: CodeFireRuntime
  events: Array<"runtime.started" | "session.ready" | "session.new" | "session.closed" | "runtime.closed">
} & JsonObject

export type CodeFireAgentSnapshot = {
  manifest: CodeFireManifest
  health: CodeFireHealth
  models: CodeFireModelCatalog
  settings: CodeFireSettings
  connections: CodeFireConnections
  mcp: CodeFireMcp
  lifecycle: CodeFireLifecycle
}

export type CodeFireFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type CodeFireAgentClientConfig = {
  baseUrl?: string | URL
  fetch?: CodeFireFetch
  headers?: HeadersInit
}

export class CodeFireAgentClientError extends Error {
  readonly status: number
  readonly path: string
  readonly body: unknown

  constructor(input: { status: number; path: string; body: unknown }) {
    super(`CodeFire agent request failed: ${input.path} returned ${input.status}`)
    this.name = "CodeFireAgentClientError"
    this.status = input.status
    this.path = input.path
    this.body = input.body
  }
}

const endpoints = {
  manifest: "/codefire/v1/manifest",
  health: "/codefire/v1/health",
  models: "/codefire/v1/models",
  settings: "/codefire/v1/settings",
  connections: "/codefire/v1/connections",
  mcp: "/codefire/v1/mcp",
  lifecycle: "/codefire/v1/lifecycle",
} as const

async function parseBody(response: Response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function requestHeaders(headers?: HeadersInit) {
  const result = new Headers(headers)
  if (!result.has("accept")) result.set("accept", "application/json")
  return result
}

function endpoint(baseUrl: string | URL, path: string) {
  return new URL(path, String(baseUrl).replace(/\/?$/, "/"))
}

export function createCodeFireAgentClient(config: CodeFireAgentClientConfig = {}) {
  const baseUrl = config.baseUrl ?? "http://localhost"
  const fetcher = config.fetch ?? globalThis.fetch

  async function get<T>(path: string): Promise<T> {
    const response = await fetcher(
      new Request(endpoint(baseUrl, path), {
        headers: requestHeaders(config.headers),
      }),
    )
    const body = await parseBody(response)
    if (!response.ok) {
      throw new CodeFireAgentClientError({ status: response.status, path, body })
    }
    return body as T
  }

  return {
    manifest: () => get<CodeFireManifest>(endpoints.manifest),
    health: () => get<CodeFireHealth>(endpoints.health),
    models: () => get<CodeFireModelCatalog>(endpoints.models),
    settings: () => get<CodeFireSettings>(endpoints.settings),
    connections: () => get<CodeFireConnections>(endpoints.connections),
    mcp: () => get<CodeFireMcp>(endpoints.mcp),
    lifecycle: () => get<CodeFireLifecycle>(endpoints.lifecycle),
    async snapshot(): Promise<CodeFireAgentSnapshot> {
      const manifest = await get<CodeFireManifest>(endpoints.manifest)
      const health = await get<CodeFireHealth>(endpoints.health)
      const models = await get<CodeFireModelCatalog>(endpoints.models)
      const settings = await get<CodeFireSettings>(endpoints.settings)
      const connections = await get<CodeFireConnections>(endpoints.connections)
      const mcp = await get<CodeFireMcp>(endpoints.mcp)
      const lifecycle = await get<CodeFireLifecycle>(endpoints.lifecycle)
      return { manifest, health, models, settings, connections, mcp, lifecycle }
    },
  }
}

export type CodeFireAgentClient = ReturnType<typeof createCodeFireAgentClient>
