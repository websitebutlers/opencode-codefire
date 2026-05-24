import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const Runtime = Schema.Struct({
  mode: Schema.Literals(["normal", "terminal", "agent-chat"]),
  cliName: Schema.Literals(["opencode", "codefire-agent"]),
  projectID: Schema.optional(Schema.String),
  parentThreadID: Schema.optional(Schema.Number),
  handoffTitle: Schema.optional(Schema.String),
})

const Product = Schema.Struct({
  name: Schema.String,
  binary: Schema.String,
  version: Schema.String,
  channel: Schema.String,
  engine: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
  }),
})

const Api = Schema.Struct({
  version: Schema.String,
  basePath: Schema.String,
  endpoints: Schema.Array(Schema.String),
})

const Paths = Schema.Struct({
  home: Schema.String,
  data: Schema.String,
  config: Schema.String,
  state: Schema.String,
  cache: Schema.String,
  tmp: Schema.String,
  log: Schema.String,
  bin: Schema.String,
})

const Capabilities = Schema.Struct({
  controlApi: Schema.Boolean,
  manifest: Schema.Boolean,
  health: Schema.Boolean,
  models: Schema.Boolean,
  settings: Schema.Boolean,
  connections: Schema.Boolean,
  mcp: Schema.Boolean,
  lifecycle: Schema.Boolean,
})

const HealthCheck = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pass", "warn", "fail"]),
  message: Schema.String,
})

const CodeFireModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  providerID: Schema.String,
  status: Schema.String,
  context: Schema.Number,
  output: Schema.Number,
})

const CodeFireProviderModels = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source: Schema.String,
  modelCount: Schema.Number,
  models: Schema.Array(CodeFireModel),
})

const DefaultModels = Schema.Record(Schema.String, Schema.String)

const CodeFireSettingsDefaults = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  smallModel: Schema.NullOr(Schema.String),
  agent: Schema.String,
})

const CodeFireSettingsBehavior = Schema.Struct({
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")]),
  share: Schema.Literals(["manual", "auto", "disabled"]),
})

const CodeFireSettingsPaths = Schema.Struct({
  config: Schema.String,
  data: Schema.String,
  state: Schema.String,
  cache: Schema.String,
})

const CodeFireConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["available", "connected"]),
  source: Schema.String,
  auth: Schema.Struct({
    env: Schema.Boolean,
    stored: Schema.Boolean,
    config: Schema.Boolean,
  }),
})

const CodeFireMcpCheck = Schema.Struct({
  status: Schema.Literals(["pass", "warn", "fail"]),
  label: Schema.String,
  detail: Schema.String,
})

const CodeFireMcpProject = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  parentThreadID: Schema.NullOr(Schema.Number),
  mode: Schema.Literals(["normal", "terminal", "agent-chat"]),
})

const CodeFireLifecycleSink = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    path: Schema.String,
    format: Schema.Literal("jsonl"),
  }),
  Schema.Struct({
    type: Schema.Literal("stderr"),
    prefix: Schema.String,
    format: Schema.Literal("jsonl"),
  }),
])

const CodeFireLifecycleEvent = Schema.Literals([
  "runtime.started",
  "session.ready",
  "session.new",
  "session.closed",
  "runtime.closed",
])

export const CodeFireManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  product: Product,
  runtime: Runtime,
  api: Api,
  paths: Paths,
  capabilities: Capabilities,
}).annotate({ identifier: "CodeFireManifest" })

export const CodeFireModels = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  defaults: DefaultModels,
  providers: Schema.Array(CodeFireProviderModels),
}).annotate({ identifier: "CodeFireModels" })

export const CodeFireSettings = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  defaults: CodeFireSettingsDefaults,
  behavior: CodeFireSettingsBehavior,
  paths: CodeFireSettingsPaths,
}).annotate({ identifier: "CodeFireSettings" })

export const CodeFireConnections = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  providers: Schema.Array(CodeFireConnection),
}).annotate({ identifier: "CodeFireConnections" })

export const CodeFireMcp = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  transport: Schema.NullOr(Schema.Literals(["local", "remote"])),
  status: Schema.Literals([
    "missing",
    "disabled",
    "uninitialized",
    "connected",
    "failed",
    "needs_auth",
    "needs_client_registration",
  ]),
  toolCount: Schema.NullOr(Schema.Number),
  project: CodeFireMcpProject,
  checks: Schema.Array(CodeFireMcpCheck),
}).annotate({ identifier: "CodeFireMcp" })

export const CodeFireLifecycle = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  enabled: Schema.Boolean,
  payload: Schema.Struct({
    kind: Schema.Literal("codefire.agent.lifecycle"),
    version: Schema.Literal(1),
  }),
  sink: CodeFireLifecycleSink,
  runtime: Runtime,
  events: Schema.Array(CodeFireLifecycleEvent),
}).annotate({ identifier: "CodeFireLifecycle" })

export const CodeFireHealth = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literals(["ok", "degraded", "fail"]),
  time: Schema.String,
  runtime: Runtime,
  checks: Schema.Array(HealthCheck),
}).annotate({ identifier: "CodeFireHealth" })

export const CodeFirePaths = {
  manifest: "/codefire/v1/manifest",
  health: "/codefire/v1/health",
  models: "/codefire/v1/models",
  settings: "/codefire/v1/settings",
  connections: "/codefire/v1/connections",
  mcp: "/codefire/v1/mcp",
  lifecycle: "/codefire/v1/lifecycle",
} as const

export const CodeFireApi = HttpApi.make("codefire").add(
  HttpApiGroup.make("codefire")
    .add(
      HttpApiEndpoint.get("manifest", CodeFirePaths.manifest, {
        success: described(CodeFireManifest, "CodeFire agent manifest"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "codefire.manifest",
          summary: "Get CodeFire agent manifest",
          description: "Discover CodeFire Terminal Agent identity, runtime, paths, and programmatic capabilities.",
        }),
      ),
      HttpApiEndpoint.get("health", CodeFirePaths.health, {
        success: described(CodeFireHealth, "CodeFire agent health"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "codefire.health",
          summary: "Get CodeFire agent health",
          description: "Check CodeFire Terminal Agent readiness for desktop and automation clients.",
        }),
      ),
      HttpApiEndpoint.get("models", CodeFirePaths.models, {
        success: described(CodeFireModels, "CodeFire agent model catalog"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "codefire.models",
          summary: "Get CodeFire model catalog",
          description: "List providers and models for CodeFire Desktop configuration screens.",
        }),
      ),
      HttpApiEndpoint.get("settings", CodeFirePaths.settings, {
        success: described(CodeFireSettings, "CodeFire agent settings"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "codefire.settings",
          summary: "Get CodeFire settings",
          description: "Read redacted CodeFire Terminal Agent defaults and behavior settings.",
        }),
      ),
      HttpApiEndpoint.get("connections", CodeFirePaths.connections, {
        success: described(CodeFireConnections, "CodeFire agent connections"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "codefire.connections",
          summary: "Get CodeFire connection readiness",
          description: "Read redacted provider connection readiness for CodeFire Desktop.",
        }),
      ),
      HttpApiEndpoint.get("mcp", CodeFirePaths.mcp, {
        success: described(CodeFireMcp, "CodeFire MCP readiness"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "codefire.mcp",
          summary: "Get CodeFire MCP readiness",
          description: "Check CodeFire MCP configuration, runtime status, and project context metadata.",
        }),
      ),
      HttpApiEndpoint.get("lifecycle", CodeFirePaths.lifecycle, {
        success: described(CodeFireLifecycle, "CodeFire lifecycle contract"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "codefire.lifecycle",
          summary: "Get CodeFire lifecycle contract",
          description: "Describe Agent Chat lifecycle event payloads and delivery sink for CodeFire Desktop.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "codefire",
        description: "CodeFire Terminal Agent control routes.",
      }),
    ),
)
