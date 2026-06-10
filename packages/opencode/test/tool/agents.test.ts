import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { AgentsTool } from "../../src/tool/agents"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    RuntimeFlags.layer(),
  ),
)

const seed = Effect.fn("AgentsToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Fan-out parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function stubOps(prompt: TaskPromptOps["prompt"]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt,
    loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "looped")),
  }
}

describe("tool.agents", () => {
  it.instance("runs all tasks concurrently and aggregates their results", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* AgentsTool
      const def = yield* tool.init()
      const promptedSessions: string[] = []

      const result = yield* def.execute(
        {
          tasks: [
            { description: "task a", prompt: "prompt-a" },
            { description: "task b", prompt: "prompt-b" },
            { description: "task c", prompt: "prompt-c" },
          ],
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps((input) =>
              Effect.sync(() => {
                promptedSessions.push(input.sessionID)
                const text = input.parts.find((part) => part.type === "text")
                return reply(input, `result-for:${text && "text" in text ? text.text : "?"}`)
              }),
            ),
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("result-for:prompt-a")
      expect(result.output).toContain("result-for:prompt-b")
      expect(result.output).toContain("result-for:prompt-c")

      const groupID = result.metadata.groupID as string
      expect(groupID).toBeDefined()
      const grouped = yield* jobs.list({ groupID })
      expect(grouped.length).toBe(3)
      expect(grouped.every((job) => job.status === "completed")).toBe(true)

      // results are collected by the tool, not injected into the parent
      expect(promptedSessions).not.toContain(chat.id)
    }),
  )

  it.instance("returns task ids immediately when wait is false", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* AgentsTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          tasks: [
            { description: "task a", prompt: "prompt-a" },
            { description: "task b", prompt: "prompt-b" },
          ],
          wait: false,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps(() => Effect.never) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const groupID = result.metadata.groupID as string
      const grouped = yield* jobs.list({ groupID })
      expect(grouped.length).toBe(2)
      expect(grouped.every((job) => job.status === "running")).toBe(true)
      for (const job of grouped) {
        expect(result.output).toContain(job.id)
        yield* jobs.cancel(job.id)
      }
    }),
  )
})
