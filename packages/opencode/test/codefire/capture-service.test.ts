import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { CodeFireBridge } from "@/codefire/bridge"
import { CodeFireCapture } from "@/codefire/capture"
import { testEffect } from "../lib/effect"

const sessionID = "ses_test" as never

const baseSession = { id: sessionID, parentID: undefined, directory: "/tmp/project" } as never

const msg = (id: string, role: "user" | "assistant", text: string) =>
  ({
    info: { id, role, providerID: "anthropic", modelID: "claude-test" },
    parts: [{ type: "text", text }],
  }) as never

type Recorder = {
  messagesCalls: number
  agentGetCalls: number
  created: { title: string; content: string }[]
}

function recorder(): Recorder {
  return { messagesCalls: 0, agentGetCalls: 0, created: [] }
}

function captureLayer(input: {
  recorder: Recorder
  codefire?: Config.Info["codefire"]
  capture: boolean
  messages?: never[]
}) {
  const configLayer = Layer.mock(Config.Service)({
    get: () => Effect.succeed({ codefire: input.codefire } as never),
  })
  const bridgeLayer = Layer.mock(CodeFireBridge.Service)({
    capabilities: () => Effect.succeed({ recall: false, capture: input.capture, tasks: false }),
    createNote: (note: { title: string; content: string }) =>
      Effect.sync(() => {
        input.recorder.created.push(note)
        return true
      }),
  })
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(baseSession),
    messages: () =>
      Effect.sync(() => {
        input.recorder.messagesCalls++
        return (input.messages ?? []) as never
      }),
  })
  const storageLayer = Layer.mock(Storage.Service)({
    read: () => Effect.succeed({ fingerprints: [] } as never),
    write: () => Effect.void,
  })
  // agents.get returning undefined makes the run exit right before model
  // selection — agentGetCalls is the "extraction stage reached" signal.
  const agentLayer = Layer.mock(Agent.Service)({
    get: () =>
      Effect.sync(() => {
        input.recorder.agentGetCalls++
        return undefined as never
      }),
  })
  const llmLayer = Layer.mock(LLM.Service)({})
  const providerLayer = Layer.mock(Provider.Service)({})

  return CodeFireCapture.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(bridgeLayer),
    Layer.provide(sessionLayer),
    Layer.provide(storageLayer),
    Layer.provide(agentLayer),
    Layer.provide(llmLayer),
    Layer.provide(providerLayer),
  )
}

const conversation = [
  msg("m1", "user", "first question"),
  msg("m2", "assistant", "first answer"),
  msg("m3", "user", "second question"),
  msg("m4", "assistant", "second answer"),
  msg("m5", "user", "third question"),
  msg("m6", "assistant", "third answer"),
] as never[]

describe("CodeFireCapture service gates", () => {
  describe("positive control: gates open", () => {
    const rec = recorder()
    const it = testEffect(captureLayer({ recorder: rec, capture: true, messages: conversation }))

    it.effect("reaches the extraction stage", () =>
      Effect.gen(function* () {
        const capture = yield* CodeFireCapture.Service
        yield* capture.capture({ sessionID, reason: "loop-exit" })
        expect(rec.messagesCalls).toBe(1)
        expect(rec.agentGetCalls).toBe(1)
      }),
    )
  })

  describe("disabled via config", () => {
    const rec = recorder()
    const it = testEffect(
      captureLayer({
        recorder: rec,
        codefire: { capture: { enabled: false } },
        capture: true,
        messages: conversation,
      }),
    )

    it.effect("no-ops before loading messages", () =>
      Effect.gen(function* () {
        const capture = yield* CodeFireCapture.Service
        yield* capture.capture({ sessionID, reason: "run-end" })
        expect(rec.messagesCalls).toBe(0)
        expect(rec.agentGetCalls).toBe(0)
      }),
    )
  })

  describe("degraded bridge", () => {
    const rec = recorder()
    const it = testEffect(captureLayer({ recorder: rec, capture: false, messages: conversation }))

    it.effect("no-ops before loading messages", () =>
      Effect.gen(function* () {
        const capture = yield* CodeFireCapture.Service
        yield* capture.capture({ sessionID, reason: "compaction" })
        expect(rec.messagesCalls).toBe(0)
        expect(rec.agentGetCalls).toBe(0)
      }),
    )
  })

  describe("loop-exit below min_turns", () => {
    const rec = recorder()
    const it = testEffect(
      captureLayer({
        recorder: rec,
        codefire: { capture: { min_turns: 3 } },
        capture: true,
        messages: [msg("m1", "user", "one question"), msg("m2", "assistant", "one answer")] as never[],
      }),
    )

    it.effect("no-ops before the extraction stage", () =>
      Effect.gen(function* () {
        const capture = yield* CodeFireCapture.Service
        yield* capture.capture({ sessionID, reason: "loop-exit" })
        expect(rec.messagesCalls).toBe(1)
        expect(rec.agentGetCalls).toBe(0)
      }),
    )
  })

  describe("compaction with a single turn", () => {
    const rec = recorder()
    const it = testEffect(
      captureLayer({
        recorder: rec,
        codefire: { capture: { min_turns: 3 } },
        capture: true,
        messages: [msg("m1", "user", "one question"), msg("m2", "assistant", "one answer")] as never[],
      }),
    )

    it.effect("still reaches extraction (min_turns only gates loop-exit)", () =>
      Effect.gen(function* () {
        const capture = yield* CodeFireCapture.Service
        yield* capture.capture({ sessionID, reason: "compaction" })
        expect(rec.agentGetCalls).toBe(1)
      }),
    )
  })
})
