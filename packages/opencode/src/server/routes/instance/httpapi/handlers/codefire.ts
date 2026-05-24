import { Auth } from "@/auth"
import { CodeFireControl } from "@/codefire/control"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"

function filterProviders(config: Config.Info, all: Record<string, ModelsDev.Provider>) {
  const disabled = new Set(config.disabled_providers ?? [])
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
  const providers: Record<string, Provider.Info> = {}
  for (const [key, value] of Object.entries(all)) {
    if (disabled.has(key)) continue
    if (enabled && !enabled.has(key)) continue
    providers[key] = Provider.fromModelsDevProvider(value)
  }
  return providers
}

export const codefireHandlers = HttpApiBuilder.group(RootHttpApi, "codefire", (handlers) =>
  Effect.gen(function* () {
    const authSvc = yield* Auth.Service
    const configSvc = yield* Config.Service
    const modelsDev = yield* ModelsDev.Service

    const manifest = Effect.fn("CodeFireHttpApi.manifest")(function* () {
      return CodeFireControl.manifest()
    })

    const health = Effect.fn("CodeFireHttpApi.health")(function* () {
      return CodeFireControl.health()
    })

    const models = Effect.fn("CodeFireHttpApi.models")(function* () {
      const config = yield* configSvc.getGlobal()
      const providers = filterProviders(config, yield* modelsDev.get())
      return CodeFireControl.models(providers, Provider.defaultModelIDs(providers))
    })

    const settings = Effect.fn("CodeFireHttpApi.settings")(function* () {
      return CodeFireControl.settings(yield* configSvc.getGlobal())
    })

    const connections = Effect.fn("CodeFireHttpApi.connections")(function* () {
      const config = yield* configSvc.getGlobal()
      const providers = filterProviders(config, yield* modelsDev.get())
      const auth = yield* authSvc.all().pipe(Effect.orDie)
      return CodeFireControl.connections(providers, auth, config)
    })

    const mcp = Effect.fn("CodeFireHttpApi.mcp")(function* () {
      const config = yield* configSvc.getGlobal()
      return CodeFireControl.mcp(config, {}, null)
    })

    const lifecycle = Effect.fn("CodeFireHttpApi.lifecycle")(function* () {
      return CodeFireControl.lifecycle()
    })

    return handlers
      .handle("manifest", manifest)
      .handle("health", health)
      .handle("models", models)
      .handle("settings", settings)
      .handle("connections", connections)
      .handle("mcp", mcp)
      .handle("lifecycle", lifecycle)
  }),
)
