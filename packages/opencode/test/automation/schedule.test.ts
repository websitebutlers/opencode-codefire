import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { BackgroundJob } from "@/background/job"
import { Schedules, nextAt, parseAt, parseEvery } from "@/automation/schedule"
import { testEffect } from "../lib/effect"

describe("parseEvery", () => {
  test("parses s/m/h/d units to milliseconds", () => {
    expect(parseEvery("90s")).toBe(90_000)
    expect(parseEvery("30m")).toBe(30 * 60_000)
    expect(parseEvery("4h")).toBe(4 * 3_600_000)
    expect(parseEvery("1d")).toBe(24 * 3_600_000)
  })
  test("rejects sub-minute intervals and garbage", () => {
    expect(parseEvery("30s")).toBeUndefined()
    expect(parseEvery("5")).toBeUndefined()
    expect(parseEvery("h4")).toBeUndefined()
    expect(parseEvery("")).toBeUndefined()
  })
})

describe("parseAt / nextAt", () => {
  test("parses HH:MM and rejects garbage", () => {
    expect(parseAt("09:00")).toEqual({ h: 9, m: 0 })
    expect(parseAt("23:59")).toEqual({ h: 23, m: 59 })
    expect(parseAt("24:00")).toBeUndefined()
    expect(parseAt("9am")).toBeUndefined()
  })
  test("nextAt rolls over to tomorrow when the time has passed", () => {
    const now = new Date(2026, 5, 10, 10, 0, 0) // local 10:00
    const later = nextAt(now, { h: 11, m: 30 })
    expect(later).toBe(90 * 60_000)
    const tomorrow = nextAt(now, { h: 9, m: 0 })
    expect(tomorrow).toBe(23 * 3_600_000)
  })
})

type Created = { title?: string }
type Prompted = { sessionID: string; agent?: string; model?: unknown; parts: unknown[] }

function scheduleLayer(input: {
  schedules?: unknown[]
  created: Created[]
  prompted: Prompted[]
  runningJob?: boolean
}) {
  const configLayer = Layer.mock(Config.Service)({
    get: () => Effect.succeed({ schedules: input.schedules } as never),
  })
  const sessionLayer = Layer.mock(Session.Service)({
    create: (create?: { title?: string }) =>
      Effect.sync(() => {
        input.created.push({ title: create?.title })
        return { id: `ses_${input.created.length}` } as never
      }),
  })
  const promptLayer = Layer.mock(SessionPrompt.Service)({
    prompt: (prompt: typeof SessionPrompt.PromptInput.Type) =>
      Effect.sync(() => {
        input.prompted.push(prompt as unknown as Prompted)
        return {} as never
      }),
  })
  const jobLayer = Layer.mock(BackgroundJob.Service)({
    start: (start: BackgroundJob.StartInput) =>
      input.runningJob
        ? Effect.succeed({ id: start.id, type: start.type, status: "running" } as never)
        : start.run.pipe(
            Effect.map(() => ({ id: start.id, type: start.type, status: "completed" }) as never),
            Effect.catch(() => Effect.succeed({ id: start.id, type: start.type, status: "error" } as never)),
          ),
  })
  return Schedules.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(sessionLayer),
    Layer.provide(promptLayer),
    Layer.provide(jobLayer),
  )
}

describe("Schedules.run", () => {
  describe("configured schedule", () => {
    const created: Created[] = []
    const prompted: Prompted[] = []
    const it = testEffect(
      scheduleLayer({
        schedules: [
          {
            name: "standup",
            every: "4h",
            prompt: "Summarize open tasks",
            agent: "plan",
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
        created,
        prompted,
      }),
    )

    it.effect("creates a titled session and prompts with agent/model/parts", () =>
      Effect.gen(function* () {
        const schedules = yield* Schedules.Service
        const job = yield* schedules.run("standup")
        expect(job).toBeDefined()
        expect(created[0]?.title).toContain("Schedule: standup")
        expect(prompted[0]?.agent).toBe("plan")
        expect(prompted[0]?.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })
        expect(prompted[0]?.parts).toEqual([{ type: "text", text: "Summarize open tasks" }])
      }),
    )

    it.effect("unknown names resolve undefined", () =>
      Effect.gen(function* () {
        const schedules = yield* Schedules.Service
        expect(yield* schedules.run("nope")).toBeUndefined()
      }),
    )
  })

  describe("overlap", () => {
    const created: Created[] = []
    const prompted: Prompted[] = []
    const it = testEffect(
      scheduleLayer({
        schedules: [{ name: "lint", every: "1h", prompt: "lint" }],
        created,
        prompted,
        runningJob: true,
      }),
    )

    it.effect("a still-running job skips the new run", () =>
      Effect.gen(function* () {
        const schedules = yield* Schedules.Service
        const job = yield* schedules.run("lint")
        expect(job?.status).toBe("running")
        // BackgroundJob returned the existing running job without executing run
        expect(created).toHaveLength(0)
        expect(prompted).toHaveLength(0)
      }),
    )
  })
})
