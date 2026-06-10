/**
 * Schedules — in-process recurring prompts from the config `schedules` block.
 *
 * Each enabled entry gets a loop forked against the instance scope (Snapshot
 * pattern): sleep until the next occurrence, run, repeat. A run creates a
 * fresh titled session and prompts it to completion — the session is the run
 * history. Runs go through BackgroundJob with a deterministic id
 * (`schedule:<name>`), so an overlapping trigger returns the still-running
 * job instead of starting a second one. In-process only: nothing persists,
 * no missed-run catch-up. `OPENCODE_DISABLE_SCHEDULES=1` disables all loops.
 */
import { Context, Duration, Effect, Layer } from "effect"
import { serviceUse } from "@/effect/service-use"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { BackgroundJob } from "@/background/job"
import { ModelID, ProviderID } from "@/provider/schema"

const log = Log.create({ service: "schedules" })

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
const MIN_INTERVAL_MS = 60_000

/** "90s" | "30m" | "4h" | "1d" → milliseconds; undefined when invalid or under 60s. */
export function parseEvery(value: string): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim())
  if (!match) return undefined
  const ms = Number(match[1]) * UNIT_MS[match[2]!]!
  return ms >= MIN_INTERVAL_MS ? ms : undefined
}

/** "HH:MM" local time → {h, m}; undefined when invalid. */
export function parseAt(value: string): { h: number; m: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return undefined
  return { h, m }
}

/** Milliseconds from `now` until the next local occurrence of `at` (today or tomorrow). */
export function nextAt(now: Date, at: { h: number; m: number }): number {
  const next = new Date(now)
  next.setHours(at.h, at.m, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

type Entry = NonNullable<Config.Info["schedules"]>[number]

export interface Interface {
  readonly init: () => Effect.Effect<void>
  /** Trigger a configured schedule now. Resolves undefined for unknown names. */
  readonly run: (name: string) => Effect.Effect<BackgroundJob.Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Schedules") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const jobs = yield* BackgroundJob.Service

    const execute = Effect.fn("Schedules.execute")(function* (entry: Entry) {
      return yield* jobs.start({
        id: `schedule:${entry.name}`,
        type: "schedule",
        title: `Schedule: ${entry.name}`,
        run: Effect.gen(function* () {
          const session = yield* sessions.create({
            title: `Schedule: ${entry.name} — ${new Date().toISOString()}`,
            agent: entry.agent,
          })
          const [providerID, modelID] = entry.model?.includes("/")
            ? [entry.model.slice(0, entry.model.indexOf("/")), entry.model.slice(entry.model.indexOf("/") + 1)]
            : [undefined, undefined]
          yield* prompt.prompt({
            sessionID: session.id,
            agent: entry.agent,
            model:
              providerID && modelID
                ? { providerID: ProviderID.make(providerID), modelID: ModelID.make(modelID) }
                : undefined,
            parts: [{ type: "text", text: entry.prompt }],
          })
          return session.id
        }),
      })
    })

    const entries = Effect.fnUntraced(function* () {
      const cfg = yield* config.get()
      return (cfg.schedules ?? []).filter((entry) => entry.enabled !== false)
    })

    const state = yield* InstanceState.make(
      Effect.fnUntraced(function* () {
        if (process.env["OPENCODE_DISABLE_SCHEDULES"]) return {}
        for (const entry of yield* entries()) {
          const everyMs = entry.every ? parseEvery(entry.every) : undefined
          const at = entry.at ? parseAt(entry.at) : undefined
          if (!everyMs && !at) {
            if (entry.every || entry.at) {
              log.warn("invalid schedule trigger, skipping", { name: entry.name, every: entry.every, at: entry.at })
            } else {
              log.warn("schedule has neither every nor at, skipping", { name: entry.name })
            }
            continue
          }
          const delay = () => Duration.millis(everyMs ?? nextAt(new Date(), at!))
          const iteration = Effect.suspend(() => Effect.sleep(delay())).pipe(
            Effect.andThen(
              execute(entry).pipe(
                Effect.tap((job) => Effect.sync(() => log.info("schedule ran", { name: entry.name, job: job.id }))),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.sync(() => log.warn("schedule run failed", { name: entry.name, cause: String(cause) })),
            ),
          )
          yield* iteration.pipe(Effect.forever, Effect.forkScoped)
          log.info("schedule armed", { name: entry.name, every: entry.every, at: entry.at })
        }
        return {}
      }),
    )

    const init = Effect.fn("Schedules.init")(function* () {
      yield* InstanceState.get(state)
    })

    const run = Effect.fn("Schedules.run")(function* (name: string) {
      const entry = (yield* entries()).find((item) => item.name === name)
      if (!entry) return undefined
      return yield* execute(entry)
    })

    return Service.of({ init, run })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as Schedules from "./schedule"
