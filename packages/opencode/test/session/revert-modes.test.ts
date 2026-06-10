import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Snapshot } from "@/snapshot"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  SessionCheckpoint.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

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

const text = Effect.fn("test.text")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text" as const,
    text: content,
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
    tokens,
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

/** One user+assistant turn that edits `file` to `next` with full snapshot parts. */
const makeTurn = (sid: SessionID, dir: string) =>
  Effect.fn("test.turn")(function* (file: string, next: string) {
    const session = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const u = yield* user(sid)
    yield* text(sid, u.id, `${file}:${next}`)
    const a = yield* assistant(sid, u.id, dir)
    const before = yield* snapshot.track()
    if (!before) throw new Error("expected snapshot")
    yield* write(path.join(dir, file), next)
    const after = yield* snapshot.track()
    if (!after) throw new Error("expected snapshot")
    const patch = yield* snapshot.patch(before)
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: a.id,
      sessionID: sid,
      type: "step-start",
      snapshot: before,
    })
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: a.id,
      sessionID: sid,
      type: "step-finish",
      reason: "stop",
      snapshot: after,
      cost: 0,
      tokens,
    })
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: a.id,
      sessionID: sid,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
    return u.id
  })

describe("revert restore modes", () => {
  it.live(
    "files mode restores files, keeps messages through cleanup",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          yield* write(path.join(dir, "a.txt"), "a0")
          const info = yield* session.create({})
          const turn = makeTurn(info.id, dir)
          const first = yield* turn("a.txt", "a1")
          yield* turn("a.txt", "a2")

          yield* revert.revert({ sessionID: info.id, messageID: first, mode: "files" })
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")
          const reverted = yield* session.get(info.id)
          expect(reverted.revert?.mode).toBe("files")

          const before = yield* session.messages({ sessionID: info.id })
          yield* revert.cleanup(reverted)
          const after = yield* session.messages({ sessionID: info.id })
          expect(after.length).toBe(before.length)
          expect((yield* session.get(info.id)).revert).toBeUndefined()
          // files stay restored
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")
          // no backup session created — nothing was removed
          expect(yield* session.children(info.id)).toHaveLength(0)
        }),
      { git: true },
    ),
  )

  it.live(
    "conversation mode leaves the working tree untouched",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          yield* write(path.join(dir, "a.txt"), "a0")
          const info = yield* session.create({})
          const turn = makeTurn(info.id, dir)
          const first = yield* turn("a.txt", "a1")

          yield* revert.revert({ sessionID: info.id, messageID: first, mode: "conversation" })
          // file keeps its post-edit content
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          const reverted = yield* session.get(info.id)
          expect(reverted.revert?.mode).toBe("conversation")

          // unrevert must not restore files either
          yield* revert.unrevert({ sessionID: info.id })
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect((yield* session.get(info.id)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup archives rewound messages into a backup child session",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          yield* write(path.join(dir, "a.txt"), "a0")
          const info = yield* session.create({})
          const turn = makeTurn(info.id, dir)
          const first = yield* turn("a.txt", "a1")
          yield* turn("a.txt", "a2")

          yield* revert.revert({ sessionID: info.id, messageID: first })
          const reverted = yield* session.get(info.id)
          const doomed = (yield* session.messages({ sessionID: info.id })).filter((m) => m.info.id >= first)
          expect(doomed.length).toBeGreaterThan(0)

          yield* revert.cleanup(reverted)
          const remaining = yield* session.messages({ sessionID: info.id })
          expect(remaining.find((m) => m.info.id === first)).toBeUndefined()

          const children = yield* session.children(info.id)
          expect(children).toHaveLength(1)
          const backup = children[0]!
          expect(backup.title).toContain("Rewind backup")
          expect(backup.time.archived).toBeDefined()
          const copied = yield* session.messages({ sessionID: backup.id })
          expect(copied.length).toBe(doomed.length)
          const copiedTexts = copied.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text))
          expect(copiedTexts).toContain("a.txt:a1")
        }),
      { git: true },
    ),
  )

  it.live(
    "preview reports the would-be-undone diff without side effects",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          yield* write(path.join(dir, "a.txt"), "a0")
          const info = yield* session.create({})
          const turn = makeTurn(info.id, dir)
          const first = yield* turn("a.txt", "a1")

          const preview = yield* revert.preview({ sessionID: info.id, messageID: first })
          expect(preview.messages).toBeGreaterThan(0)
          expect(preview.diffs.map((d) => d.file)).toContain("a.txt")

          // zero side effects: file unchanged, no revert state, messages intact
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect((yield* session.get(info.id)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
