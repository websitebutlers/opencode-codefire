import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(BackgroundJob.defaultLayer, Bus.layer))

describe("background.job", () => {
  it.instance("tracks started jobs through completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        title: "test job",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job.id.startsWith("job_")).toBe(true)
      expect(job.status).toBe("running")
      expect(job.title).toBe("test job")

      yield* Deferred.succeed(latch, undefined)
      const done = yield* jobs.wait({ id: job.id })

      expect(done.timedOut).toBe(false)
      expect(done.info?.status).toBe("completed")
      expect(done.info?.output).toBe("done")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([job.id])
    }),
  )

  it.instance("returns a running snapshot when wait times out", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never,
      })

      const result = yield* jobs.wait({ id: job.id, timeout: 1 })

      expect(result.timedOut).toBe(true)
      expect(result.info?.status).toBe("running")
    }),
  )

  it.instance("deduplicates concurrent starts for a running id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const id = "job_test"
      const [first, second] = yield* Effect.all(
        [
          jobs.start({
            id,
            type: "test",
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          jobs.start({
            id,
            type: "test",
            run: Effect.fail(new Error("duplicate started")),
          }),
        ],
        { concurrency: "unbounded" },
      )

      yield* Deferred.await(started)

      expect(first.id).toBe(id)
      expect(second.id).toBe(id)
      expect(first.status).toBe("running")
      expect(second.status).toBe("running")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([id])

      yield* jobs.cancel(id)
    }),
  )

  it.instance("records failed jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.fail(new Error("boom")),
      })

      const result = yield* jobs.wait({ id: job.id })

      expect(result.info?.status).toBe("error")
      expect(result.info?.error).toBe("boom")
    }),
  )

  it.instance("can cancel running jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      const cancelled = yield* jobs.cancel(job.id)

      expect(cancelled?.status).toBe("cancelled")
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("filters list by groupID", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ type: "test", groupID: "g1", run: Effect.succeed("a") })
      yield* jobs.start({ type: "test", groupID: "g1", run: Effect.succeed("b") })
      yield* jobs.start({ type: "test", run: Effect.succeed("c") })

      const grouped = yield* jobs.list({ groupID: "g1" })

      expect(grouped.length).toBe(2)
      expect(grouped.every((item) => item.groupID === "g1")).toBe(true)
      expect((yield* jobs.list()).length).toBe(3)
    }),
  )

  it.instance("publishes bus events on status transitions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const bus = yield* Bus.Service
      const seen: { id: string; status: string }[] = []
      const completed = yield* Deferred.make<void>()

      yield* bus.subscribeCallback(BackgroundJob.Event.Updated, (evt) => {
        seen.push({ id: evt.properties.info.id, status: evt.properties.info.status })
        if (evt.properties.info.status === "completed") Deferred.doneUnsafe(completed, Effect.void)
      })

      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })
      yield* Deferred.succeed(latch, undefined)
      yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"))

      expect(seen).toEqual([
        { id: job.id, status: "running" },
        { id: job.id, status: "completed" },
      ])
    }),
  )

  it.instance("does not publish an event for a deduplicated start", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const bus = yield* Bus.Service
      const seen: string[] = []
      const cancelled = yield* Deferred.make<void>()

      yield* bus.subscribeCallback(BackgroundJob.Event.Updated, (evt) => {
        seen.push(evt.properties.info.status)
        if (evt.properties.info.status === "cancelled") Deferred.doneUnsafe(cancelled, Effect.void)
      })

      const id = "job_dedupe_events"
      yield* jobs.start({ id, type: "test", run: Effect.never })
      yield* jobs.start({ id, type: "test", run: Effect.never })
      yield* jobs.cancel(id)
      yield* Deferred.await(cancelled).pipe(Effect.timeout("2 seconds"))

      expect(seen).toEqual(["running", "cancelled"])
    }),
  )

  it.instance("limits concurrent runs for jobs sharing a slot key", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started: string[] = []
      const gate = yield* Deferred.make<void>()

      const job = (name: string) =>
        jobs.start({
          id: `job_slot_${name}`,
          type: "test",
          slot: { key: "test-slot", limit: 1 },
          run: Effect.gen(function* () {
            started.push(name)
            yield* Deferred.await(gate)
            return name
          }),
        })

      yield* job("first")
      yield* job("second")
      yield* Effect.sleep("50 millis")

      expect(started).toEqual(["first"])

      yield* Deferred.succeed(gate, undefined)
      const [first, second] = yield* Effect.all([
        jobs.wait({ id: "job_slot_first" }),
        jobs.wait({ id: "job_slot_second" }),
      ])

      expect(first.info?.status).toBe("completed")
      expect(second.info?.status).toBe("completed")
      expect(started).toEqual(["first", "second"])
    }),
  )

  it.instance("returns immutable snapshots", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        metadata: { value: "initial" },
        run: Effect.succeed("done"),
      })

      if (job.metadata) job.metadata.value = "changed"

      expect((yield* jobs.get(job.id))?.metadata?.value).toBe("initial")
    }),
  )
})
