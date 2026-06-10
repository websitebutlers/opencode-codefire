import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "@/bus"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, Bus.layer))

const sessionID = "ses_status_test" as SessionID

describe("session.status", () => {
  it.instance("waitIdle resolves when the session becomes idle", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      yield* status.set(sessionID, { type: "busy" })

      const waiter = yield* status.waitIdle(sessionID).pipe(Effect.as("resumed"), Effect.forkChild())
      yield* status.set(sessionID, { type: "idle" })

      expect(yield* Fiber.join(waiter).pipe(Effect.timeout("2 seconds"))).toBe("resumed")
    }),
  )

  it.instance("waitIdle resolves immediately when the session is already idle", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service

      expect(yield* status.waitIdle(sessionID).pipe(Effect.as("resumed"), Effect.timeout("2 seconds"))).toBe("resumed")
    }),
  )
})
