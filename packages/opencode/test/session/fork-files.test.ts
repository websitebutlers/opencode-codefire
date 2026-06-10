import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Snapshot } from "@/snapshot"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionCheckpoint.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

const user = Effect.fn("test.user")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: "default",
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

describe("restore file state at a checkpoint (fork-with-files)", () => {
  it.live(
    "restoreTo restores the worktree and pins a safety checkpoint first",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const checkpoint = yield* SessionCheckpoint.Service
          const snapshot = yield* Snapshot.Service

          // checkpointed state
          yield* write(path.join(dir, "a.txt"), "old")
          const info = yield* session.create({})
          const msg = yield* user(info.id)
          const anchor = yield* snapshot.track()
          yield* checkpoint.create({ sessionID: info.id, messageID: msg.id, snapshot: anchor! })

          // uncommitted current work
          yield* write(path.join(dir, "a.txt"), "new")
          yield* write(path.join(dir, "b.txt"), "scratch")

          const restored = yield* checkpoint.restoreTo({ sessionID: info.id, messageID: msg.id })
          expect(restored).toBe(anchor!)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("old")

          // the pre-restore work is recoverable through a manual safety checkpoint
          const list = yield* checkpoint.list({ sessionID: info.id })
          const safety = list.find((c) => c.source === "manual")
          expect(safety).toBeDefined()
          yield* snapshot.restore(safety!.snapshot)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("new")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("scratch")
        }),
      { git: true },
    ),
  )

  it.live(
    "restoreTo resolves undefined when no anchor exists",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const checkpoint = yield* SessionCheckpoint.Service
          const info = yield* session.create({})
          const restored = yield* checkpoint.restoreTo({ sessionID: info.id, messageID: MessageID.ascending() })
          expect(restored).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
