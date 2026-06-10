import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "../bus"
import { BusEvent } from "@/bus/bus-event"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "../sync"
import * as Log from "@opencode-ai/core/util/log"
import * as Session from "./session"
import { SessionCheckpoint } from "./checkpoint"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

const log = Log.create({ service: "session.revert" })

export const RevertMode = Schema.Literals(["conversation", "files", "both"])
export type RevertMode = Schema.Schema.Type<typeof RevertMode>

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
  mode: Schema.optional(RevertMode),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export const Preview = Schema.Struct({
  diffs: Schema.Array(Snapshot.FileDiff),
  messages: Schema.Finite,
}).annotate({ identifier: "RevertPreview" })
export type Preview = Schema.Schema.Type<typeof Preview>

/** Published when cleanup archives rewound messages into a backup session. */
export const RewindArchived = BusEvent.define(
  "session.rewind.archived",
  Schema.Struct({
    sessionID: SessionID,
    backupID: SessionID,
  }),
)

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
  /** Diff and message count a revert would undo, with zero side effects. */
  readonly preview: (input: RevertInput) => Effect.Effect<Preview>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

/**
 * Walk the message history to locate the revert point for the given
 * message/part and collect the file patches recorded after it. Shared by
 * revert() and preview().
 */
export function findRevertPoint(
  messages: readonly MessageV2.WithParts[],
  input: { messageID: MessageID; partID?: PartID },
) {
  let lastUser: MessageV2.User | undefined
  let rev: Session.Info["revert"]
  const patches: Snapshot.Patch[] = []
  for (const msg of messages) {
    if (msg.info.role === "user") lastUser = msg.info
    const remaining = []
    for (const part of msg.parts) {
      if (rev) {
        if (part.type === "patch") patches.push(part)
        continue
      }

      if (!rev) {
        if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
          const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
          rev = {
            messageID: !partID && lastUser ? lastUser.id : msg.info.id,
            partID,
          }
        }
        remaining.push(part)
      }
    }
  }
  return { rev, patches }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service
    const checkpoint = yield* SessionCheckpoint.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const mode = input.mode ?? "both"

      const { rev, patches } = findRevertPoint(all, input)
      if (!rev) return session
      rev.mode = mode

      // Always capture the pre-revert tree so any mode can be undone (and a
      // later files restore stays possible after a conversation-only rewind).
      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (mode !== "conversation") {
        if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
        yield* snap.revert(patches)
        if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      }
      const range = all.filter((msg) => msg.info.id >= rev.messageID)
      const diffs = mode === "conversation" ? [] : yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      // a conversation-only rewind never touched files, so don't restore them
      if (session.revert.snapshot && session.revert.mode !== "conversation") {
        yield* snap.restore(session.revert.snapshot)
      }
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const preview = Effect.fn("SessionRevert.preview")(function* (input: RevertInput) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const { rev } = findRevertPoint(all, input)
      if (!rev) return { diffs: [], messages: 0 } satisfies Preview
      const range = all.filter((msg) => msg.info.id >= rev.messageID)
      let diffs = yield* summary.computeDiff({ messages: range })
      if (!diffs.length) {
        // no step anchors in range (e.g. aborted turn) — diff the checkpoint
        // anchor against the current tree instead
        const anchor = yield* checkpoint.resolveAnchor({ sessionID: input.sessionID, messageID: rev.messageID })
        const current = yield* snap.track()
        if (anchor && current && anchor !== current) {
          diffs = yield* snap.diffFull(anchor, current)
        }
      }
      return { diffs, messages: range.length } satisfies Preview
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      // files-only rewinds keep the conversation: just drop the pointer
      if (session.revert.mode === "files") {
        yield* sessions.clearRevert(sessionID)
        return
      }
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      // Archive the doomed messages into a hidden child session before the
      // destructive removal below, so a rewind never permanently loses work.
      if (remove.length > 0) {
        yield* Effect.gen(function* () {
          const backup = yield* sessions.create({
            parentID: sessionID,
            title: `Rewind backup — ${session.title}`,
          })
          yield* sessions.copyMessages(remove, backup.id)
          yield* sessions.setArchived({ sessionID: backup.id, time: Date.now() })
          yield* bus.publish(RewindArchived, { sessionID, backupID: backup.id })
        }).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.warn("rewind archive failed", { cause: String(cause) }))),
        )
      }
      for (const msg of remove) {
        yield* sync.run(MessageV2.Event.Removed, {
          sessionID,
          messageID: msg.info.id,
        })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sync.run(MessageV2.Event.PartRemoved, {
              sessionID,
              messageID: target.info.id,
              partID: part.id,
            })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup, preview })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
