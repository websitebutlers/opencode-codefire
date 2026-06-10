/**
 * CodeFireCapture — automatic memory capture.
 *
 * Extracts durable findings (gotchas, decisions, architecture facts) from a
 * session transcript with a small model and persists them as CodeFire notes
 * via the desktop bridge. Triggered before compaction, at the end of
 * non-interactive runs, and after enough new turns at loop exit. Always
 * non-blocking and best-effort: any failure or missing capability is a no-op.
 *
 * The service itself is CodeFire-agnostic: call sites are responsible for the
 * cheap `CodeFire.active()` guard before invoking it.
 */
import { Context, Effect, Layer, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { serviceUse } from "@/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { CodeFireBridge } from "./bridge"

const log = Log.create({ service: "codefire.capture" })

export const CAPTURE_DEFAULT_MAX_NOTES = 3
export const CAPTURE_DEFAULT_MIN_TURNS = 3
export const CAPTURE_TIMEOUT_MS = 30_000
const PROJECT_FINGERPRINT_LIMIT = 500

export type ExtractedNote = { title: string; content: string }

export type TranscriptEntry = { role: "user" | "assistant"; text: string }

const NOTE_LINE = /^\s*(?:\d+[.)]|-)\s+(.*)$/
const MAX_TITLE = 80

/**
 * Parse the extraction model's output into notes. Accepts numbered or dash
 * bullets in the form `<title> :: <content>`; lines without the separator get
 * a title derived from the content. `NONE` (or no marked lines) means no
 * durable findings.
 */
export function parseNotes(output: string): ExtractedNote[] {
  const trimmed = output.trim()
  if (!trimmed || trimmed.toLowerCase() === "none") return []

  const notes: ExtractedNote[] = []
  for (const line of trimmed.split("\n")) {
    const match = NOTE_LINE.exec(line)
    if (!match) continue
    const body = match[1]!.trim()
    if (!body || body.toLowerCase() === "none") continue
    const separator = body.indexOf(" :: ")
    if (separator > 0) {
      const title = body.slice(0, separator).trim()
      const content = body.slice(separator + 4).trim()
      if (title && content) notes.push({ title, content })
      continue
    }
    const title = body.length > MAX_TITLE ? body.slice(0, MAX_TITLE - 1).trimEnd() + "…" : body
    notes.push({ title, content: body })
  }
  return notes
}

/** Stable content hash for dedup across sessions; whitespace/case-insensitive. */
export function fingerprint(note: ExtractedNote): string {
  const normalized = `${note.title}\n${note.content}`.toLowerCase().replace(/\s+/g, " ").trim()
  // FNV-1a, 32-bit — cheap, deterministic, collision-tolerant for this purpose.
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

type MessageLike = {
  info: { id: string; role: string }
  parts: readonly { type: string; text?: string; synthetic?: boolean }[]
}

/**
 * Build a plain transcript from session messages newer than `lastMessageID`.
 * Synthetic parts (injected context, reminders) are excluded. When the id is
 * not found (e.g. state from a deleted message), the whole history is used.
 */
export function selectTranscript(messages: readonly MessageLike[], lastMessageID?: string) {
  const start = lastMessageID ? messages.findIndex((message) => message.info.id === lastMessageID) + 1 : 0
  const selected = messages.slice(start)

  const transcript: TranscriptEntry[] = []
  let newUserTurns = 0
  for (const message of selected) {
    if (message.info.role !== "user" && message.info.role !== "assistant") continue
    const text = message.parts
      .filter((part) => part.type === "text" && !part.synthetic && part.text)
      .map((part) => part.text!)
      .join("\n")
    if (!text) continue
    if (message.info.role === "user") newUserTurns++
    transcript.push({ role: message.info.role, text })
  }

  return {
    transcript,
    newUserTurns,
    lastMessageID: selected.at(-1)?.info.id ?? lastMessageID,
  }
}

/** Drop notes already captured (by fingerprint) or duplicated in-batch; cap the rest. */
export function dedupeNotes(notes: ExtractedNote[], known: ReadonlySet<string>, maxNotes: number): ExtractedNote[] {
  const seen = new Set(known)
  const fresh: ExtractedNote[] = []
  for (const note of notes) {
    const print = fingerprint(note)
    if (seen.has(print)) continue
    seen.add(print)
    fresh.push(note)
    if (fresh.length >= maxNotes) break
  }
  return fresh
}

export function buildExtractionPrompt(transcript: TranscriptEntry[]): string {
  const conversation = transcript
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`)
    .join("\n\n")

  return [
    "Extract durable project knowledge from this coding-session transcript: non-obvious gotchas,",
    "architectural decisions and their rationale, bug root causes, and constraints a future session",
    "would otherwise have to rediscover.",
    "",
    "Rules:",
    "- Only include findings that stay true beyond this session. No progress updates, no TODO lists,",
    "  nothing derivable from a quick look at the code.",
    "- Output one finding per line as: `1. <short title> :: <one or two sentence explanation>`",
    "- At most 5 findings, best first.",
    "- If nothing qualifies, output exactly: NONE",
    "",
    "Transcript:",
    "",
    conversation,
  ].join("\n")
}

export type CaptureReason = "compaction" | "run-end" | "loop-exit"

export interface Interface {
  /**
   * Extract durable findings from the session's new messages and persist
   * them as CodeFire notes. Best-effort: never fails, bounded by
   * CAPTURE_TIMEOUT_MS, and a no-op when disabled or the bridge is degraded.
   */
  readonly capture: (input: { sessionID: SessionID; reason: CaptureReason }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeFireCapture") {}

export const use = serviceUse(Service)

type CaptureState = { lastMessageID?: string; fingerprints: string[] }

const sessionKey = (sessionID: string) => ["codefire", "capture", "session", sessionID]
const projectKey = (directory: string) => ["codefire", "capture", "project", directory.replace(/[/\\:]+/g, "-")]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bridge = yield* CodeFireBridge.Service
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service

    const readState = (key: string[]) =>
      storage.read<CaptureState>(key).pipe(Effect.orElseSucceed((): CaptureState => ({ fingerprints: [] })))

    const run = Effect.fn("CodeFireCapture.run")(function* (input: { sessionID: SessionID; reason: CaptureReason }) {
      const cfg = yield* config.get()
      if (cfg.codefire?.capture?.enabled === false) return
      const session = yield* sessions.get(input.sessionID)
      if (session.parentID) return
      const capabilities = yield* bridge.capabilities()
      if (!capabilities.capture) return

      const maxNotes = cfg.codefire?.capture?.max_notes ?? CAPTURE_DEFAULT_MAX_NOTES
      const minTurns = cfg.codefire?.capture?.min_turns ?? CAPTURE_DEFAULT_MIN_TURNS

      const state = yield* readState(sessionKey(input.sessionID))
      const messages = yield* sessions.messages({ sessionID: input.sessionID })
      const selected = selectTranscript(messages, state.lastMessageID)
      if (selected.transcript.length === 0) return
      if (selected.newUserTurns < (input.reason === "loop-exit" ? minTurns : 1)) return

      const lastAssistant = messages.findLast((m) => m.info.role === "assistant")?.info as
        | MessageV2.Assistant
        | undefined
      const lastUser = messages.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
      if (!lastAssistant || !lastUser) return

      const ag = yield* agents.get("codefire-capture")
      if (!ag) return
      const model = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(lastAssistant.providerID)) ??
          (yield* provider.getModel(lastAssistant.providerID, lastAssistant.modelID)))

      const output = yield* llm
        .stream({
          agent: ag,
          user: lastUser,
          system: [],
          small: true,
          tools: {},
          model,
          sessionID: input.sessionID,
          retries: 1,
          messages: [{ role: "user", content: buildExtractionPrompt(selected.transcript) }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
        )

      const project = yield* readState(projectKey(session.directory))
      const known = new Set([...state.fingerprints, ...project.fingerprints])
      const fresh = dedupeNotes(parseNotes(output), known, maxNotes)

      const created: string[] = []
      for (const note of fresh) {
        const ok = yield* bridge.createNote(note)
        if (ok) created.push(fingerprint(note))
      }
      log.info("capture", { reason: input.reason, extracted: fresh.length, created: created.length })

      // Advance state even when nothing was created so the same window is
      // not re-extracted on the next trigger.
      yield* storage
        .write(sessionKey(input.sessionID), {
          lastMessageID: selected.lastMessageID,
          fingerprints: [...state.fingerprints, ...created],
        })
        .pipe(Effect.ignore)
      if (created.length > 0) {
        yield* storage
          .write(projectKey(session.directory), {
            fingerprints: [...project.fingerprints, ...created].slice(-PROJECT_FINGERPRINT_LIMIT),
          })
          .pipe(Effect.ignore)
      }
    })

    return Service.of({
      capture: (input) =>
        run(input).pipe(
          Effect.timeout(CAPTURE_TIMEOUT_MS),
          Effect.catchCause((cause) => Effect.sync(() => log.warn("capture failed", { cause: String(cause) }))),
        ),
    })
  }),
)

export const CodeFireCapture = {
  Service,
  use,
  layer,
  buildExtractionPrompt,
  dedupeNotes,
  fingerprint,
  parseNotes,
  selectTranscript,
  CAPTURE_DEFAULT_MAX_NOTES,
  CAPTURE_DEFAULT_MIN_TURNS,
  CAPTURE_TIMEOUT_MS,
}
