import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Snapshot } from "@/snapshot"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  SessionCheckpoint.defaultLayer,
  Session.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

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

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

const shadowGitdir = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  return path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
})

const refs = (gitdir: string, prefix: string) =>
  Effect.promise(async () => {
    const out = await $`git --git-dir ${gitdir} for-each-ref refs/checkpoints/${prefix}`.quiet().nothrow()
    return out.stdout.toString()
  })

describe("session checkpoints", () => {
  it.live(
    "create stores a row, pins a shadow-repo ref, and list returns it",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const checkpoint = yield* SessionCheckpoint.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "v0")
          const info = yield* session.create({})
          const msg = yield* user(info.id)
          const hash = yield* snapshot.track()
          expect(hash).toBeTruthy()

          const created = yield* checkpoint.create({ sessionID: info.id, messageID: msg.id, snapshot: hash! })
          expect(created.sessionID).toBe(info.id)
          expect(created.messageID).toBe(msg.id)
          expect(created.snapshot).toBe(hash!)
          expect(created.source).toBe("prompt")

          const list = yield* checkpoint.list({ sessionID: info.id })
          expect(list.map((c) => c.messageID)).toContain(msg.id)

          const gitdir = yield* shadowGitdir
          const pinned = yield* refs(gitdir, info.id)
          expect(pinned).toContain(hash!)
          expect(pinned).toContain(msg.id)
        }),
      { git: true },
    ),
  )

  it.live(
    "resolveAnchor prefers checkpoint rows and falls back to step-start parts",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const checkpoint = yield* SessionCheckpoint.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "v0")
          const info = yield* session.create({})

          // turn 1: checkpoint row
          const msg1 = yield* user(info.id)
          const hash1 = yield* snapshot.track()
          yield* checkpoint.create({ sessionID: info.id, messageID: msg1.id, snapshot: hash1! })

          // turn 2: no row, only a step-start part on the assistant reply
          yield* write(path.join(dir, "a.txt"), "v1")
          const msg2 = yield* user(info.id)
          const reply = yield* assistant(info.id, msg2.id, dir)
          const hash2 = yield* snapshot.track()
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: info.id,
            type: "step-start" as const,
            snapshot: hash2!,
          })

          expect(yield* checkpoint.resolveAnchor({ sessionID: info.id, messageID: msg1.id })).toBe(hash1!)
          expect(yield* checkpoint.resolveAnchor({ sessionID: info.id, messageID: msg2.id })).toBe(hash2!)
          expect(
            yield* checkpoint.resolveAnchor({ sessionID: info.id, messageID: MessageID.ascending() }),
          ).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "list unions derived step-start anchors for messages without rows",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const checkpoint = yield* SessionCheckpoint.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "v0")
          const info = yield* session.create({})
          const msg = yield* user(info.id)
          const reply = yield* assistant(info.id, msg.id, dir)
          const hash = yield* snapshot.track()
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: info.id,
            type: "step-start" as const,
            snapshot: hash!,
          })

          const list = yield* checkpoint.list({ sessionID: info.id })
          const derived = list.find((c) => c.messageID === msg.id)
          expect(derived).toBeDefined()
          expect(derived!.snapshot).toBe(hash!)
          expect(derived!.source).toBe("derived")
        }),
      { git: true },
    ),
  )

  it.live(
    "session delete unpins the shadow-repo refs",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const checkpoint = yield* SessionCheckpoint.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "v0")
          const info = yield* session.create({})
          const msg = yield* user(info.id)
          const hash = yield* snapshot.track()
          yield* checkpoint.create({ sessionID: info.id, messageID: msg.id, snapshot: hash! })

          const gitdir = yield* shadowGitdir
          expect(yield* refs(gitdir, info.id)).toContain(hash!)

          yield* session.remove(info.id)

          // unpin runs via bus subscription; poll briefly for it to land
          let pinned = ""
          for (let i = 0; i < 50; i++) {
            pinned = yield* refs(gitdir, info.id)
            if (!pinned) break
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
          }
          expect(pinned).toBe("")
        }),
      { git: true },
    ),
  )
})
