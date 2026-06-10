/**
 * SessionCheckpoint — first-class file-state checkpoints per session.
 *
 * Each checkpoint pairs a message with a snapshot tree hash from the git
 * shadow repo (src/snapshot). Rows are written directly to SQLite (Todo
 * pattern), and every created checkpoint pins its tree via a
 * refs/checkpoints/<sessionID>/<messageID> ref so the snapshot GC never
 * prunes it while the session exists. Sessions created before the
 * checkpoint table still resolve anchors from assistant step-start parts.
 */
import { Effect, Layer, Context, Schema, Stream, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { asc, eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Bus } from "@/bus"
import { serviceUse } from "@/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import * as Session from "./session"
import { Snapshot } from "@/snapshot"
import { CheckpointTable } from "./session.sql"
import { CheckpointID, MessageID, SessionID } from "./schema"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "session.checkpoint" })

export const Source = Schema.Literals(["prompt", "fork", "manual", "derived"])
export type Source = Schema.Schema.Type<typeof Source>

export const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
}).annotate({ identifier: "CheckpointSummary" })

export const Info = Schema.Struct({
  // derived (step-start anchored) checkpoints have no persisted row, hence no id
  id: Schema.optional(CheckpointID),
  sessionID: SessionID,
  messageID: MessageID,
  snapshot: Schema.String,
  source: Source,
  time: Schema.Struct({ created: Schema.Finite }),
  summary: Schema.optional(Summary),
}).annotate({ identifier: "Checkpoint" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  /** Persist a checkpoint row and pin its snapshot tree in the shadow repo. */
  readonly create: (input: {
    sessionID: SessionID
    messageID: MessageID
    snapshot: string
    source?: "prompt" | "fork" | "manual"
  }) => Effect.Effect<Info>
  /**
   * All checkpoints for a session, ordered by message. Unions persisted rows
   * with anchors derived from assistant step-start parts for messages that
   * predate the checkpoint table. `stats` adds per-checkpoint file-change
   * numbers (diff against the previous checkpoint).
   */
  readonly list: (input: { sessionID: SessionID; stats?: boolean }) => Effect.Effect<Info[]>
  /** Snapshot hash anchored at a message: its row, else the answering assistant turn's step-start. */
  readonly resolveAnchor: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<string | undefined>
  /**
   * Restore the working tree to the checkpoint anchored at a message,
   * pinning the current (pre-restore) tree as a manual safety checkpoint
   * first so uncommitted work stays recoverable. Resolves to the restored
   * anchor, or undefined when none exists.
   */
  readonly restoreTo: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCheckpoint") {}

export const use = serviceUse(Service)

/**
 * Scan forward from `messageID` to the next user message and return the
 * first step-start snapshot found on assistant replies in between.
 */
export function anchorFromMessages(messages: readonly MessageV2.WithParts[], messageID: MessageID) {
  const start = messages.findIndex((message) => message.info.id === messageID)
  if (start === -1) return undefined
  for (let i = start; i < messages.length; i++) {
    const message = messages[i]!
    if (i > start && message.info.role === "user") return undefined
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type === "step-start" && part.snapshot) return part.snapshot
    }
  }
  return undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service

    // Per-instance init: the bus is instance-scoped, so the Deleted
    // subscription must be established from within instance context (the
    // vcs.ts pattern). Drops retention pins when a session is deleted; the
    // checkpoint rows themselves cascade via FK.
    const state = yield* InstanceState.make(
      Effect.fnUntraced(function* () {
        yield* bus.subscribe(Session.Event.Deleted).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.runForEach((evt) =>
                snapshot
                  .unpin(evt.properties.sessionID)
                  .pipe(
                    Effect.catchCause((cause) => Effect.sync(() => log.warn("unpin failed", { cause: String(cause) }))),
                  ),
              ),
              Effect.forkScoped,
            ),
          ),
        )
        return {}
      }),
    )

    const create = Effect.fn("SessionCheckpoint.create")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      snapshot: string
      source?: "prompt" | "fork" | "manual"
    }) {
      yield* InstanceState.get(state)
      const id = CheckpointID.ascending()
      const source = input.source ?? "prompt"
      const created = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(CheckpointTable)
            .values({
              id,
              session_id: input.sessionID,
              message_id: input.messageID,
              snapshot: input.snapshot,
              source,
            })
            .run(),
        ),
      )
      yield* snapshot.pin(`${input.sessionID}/${input.messageID}`, input.snapshot).pipe(Effect.ignore)
      return {
        id,
        sessionID: input.sessionID,
        messageID: input.messageID,
        snapshot: input.snapshot,
        source,
        time: { created },
      } satisfies Info
    })

    const rows = Effect.fnUntraced(function* (sessionID: SessionID) {
      return yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(CheckpointTable)
            .where(eq(CheckpointTable.session_id, sessionID))
            .orderBy(asc(CheckpointTable.message_id))
            .all(),
        ),
      )
    })

    const history = Effect.fnUntraced(function* (sessionID: SessionID) {
      return yield* sessions
        .messages({ sessionID })
        .pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
    })

    const list = Effect.fn("SessionCheckpoint.list")(function* (input: { sessionID: SessionID; stats?: boolean }) {
      yield* InstanceState.get(state)
      const persisted = yield* rows(input.sessionID)
      const have = new Set<string>(persisted.map((row) => row.message_id))
      const result: Info[] = persisted.map(
        (row) =>
          ({
            id: row.id,
            sessionID: row.session_id,
            messageID: row.message_id,
            snapshot: row.snapshot,
            source: row.source,
            time: { created: row.time_created },
          }) satisfies Info,
      )

      const messages = yield* history(input.sessionID)
      for (const message of messages) {
        if (message.info.role !== "user" || have.has(message.info.id)) continue
        const anchor = anchorFromMessages(messages, message.info.id)
        if (!anchor) continue
        result.push({
          sessionID: input.sessionID,
          messageID: message.info.id,
          snapshot: anchor,
          source: "derived",
          time: { created: message.info.time.created },
        })
      }

      result.sort((a, b) => (a.messageID < b.messageID ? -1 : a.messageID > b.messageID ? 1 : 0))

      if (input.stats) {
        for (let i = 1; i < result.length; i++) {
          const prev = result[i - 1]!
          const current = result[i]!
          if (prev.snapshot === current.snapshot) {
            current.summary = { additions: 0, deletions: 0, files: 0 }
            continue
          }
          const diffs = yield* snapshot
            .diffFull(prev.snapshot, current.snapshot)
            .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
          current.summary = {
            additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
            deletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
            files: diffs.length,
          }
        }
      }

      return result
    })

    const resolveAnchor = Effect.fn("SessionCheckpoint.resolveAnchor")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* InstanceState.get(state)
      const persisted = yield* rows(input.sessionID)
      const hit = persisted.find((row) => row.message_id === input.messageID)
      if (hit) return hit.snapshot
      return anchorFromMessages(yield* history(input.sessionID), input.messageID)
    })

    const restoreTo = Effect.fn("SessionCheckpoint.restoreTo")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* InstanceState.get(state)
      const anchor = yield* resolveAnchor(input)
      if (!anchor) return undefined
      const current = yield* snapshot.track()
      if (current) {
        const last = (yield* history(input.sessionID)).at(-1)
        if (last) {
          yield* create({
            sessionID: input.sessionID,
            messageID: last.info.id,
            snapshot: current,
            source: "manual",
          }).pipe(Effect.ignore)
        }
      }
      if (current !== anchor) yield* snapshot.restore(anchor)
      return anchor
    })

    return Service.of({ create, list, resolveAnchor, restoreTo })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(Session.defaultLayer), Layer.provide(Snapshot.defaultLayer), Layer.provide(Bus.layer)),
)

export * as SessionCheckpoint from "./checkpoint"
