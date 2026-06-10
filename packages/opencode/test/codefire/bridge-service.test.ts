import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MCP } from "@/mcp"
import { CodeFireBridge } from "@/codefire/bridge"
import { testEffect } from "../lib/effect"

const FULL_DEFS = [
  { name: "context_search" },
  { name: "suggest_wiki_pages" },
  { name: "list_tasks" },
  { name: "create_note" },
] as never[]

const MINIMAL_DEFS = [{ name: "codefire_info" }] as never[]

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] })

function mockMcp(input: {
  defs: never[] | undefined
  onCall?: (clientName: string, toolName: string, args?: Record<string, unknown>) => unknown
  calls?: { tool: string; args?: Record<string, unknown> }[]
}) {
  return Layer.mock(MCP.Service)({
    toolDefs: (clientName: string) => Effect.succeed(clientName === "codefire" ? input.defs : undefined),
    callTool: (clientName: string, toolName: string, args?: Record<string, unknown>) =>
      Effect.sync(() => {
        input.calls?.push({ tool: toolName, args })
        return input.onCall?.(clientName, toolName, args) as never
      }),
  })
}

describe("CodeFireBridge service", () => {
  describe("with full desktop bridge", () => {
    const calls: { tool: string; args?: Record<string, unknown> }[] = []
    const it = testEffect(
      CodeFireBridge.layer.pipe(
        Layer.provide(
          mockMcp({
            defs: FULL_DEFS,
            calls,
            onCall: (_client, tool) => {
              if (tool === "create_note") return textResult("created")
              return textResult(`${tool} result`)
            },
          }),
        ),
      ),
    )

    it.effect("reports full capabilities", () =>
      Effect.gen(function* () {
        const bridge = yield* CodeFireBridge.Service
        expect(yield* bridge.capabilities()).toEqual({ recall: true, capture: true, tasks: true })
      }),
    )

    it.effect("contextSearch returns joined text and passes the query", () =>
      Effect.gen(function* () {
        const bridge = yield* CodeFireBridge.Service
        calls.length = 0
        expect(yield* bridge.contextSearch("auth flow")).toBe("context_search result")
        expect(calls).toEqual([{ tool: "context_search", args: { query: "auth flow" } }])
      }),
    )

    it.effect("createNote returns true on success", () =>
      Effect.gen(function* () {
        const bridge = yield* CodeFireBridge.Service
        expect(yield* bridge.createNote({ title: "Gotcha", content: "details" })).toBe(true)
      }),
    )
  })

  describe("with bundled minimal server", () => {
    const calls: { tool: string; args?: Record<string, unknown> }[] = []
    const it = testEffect(CodeFireBridge.layer.pipe(Layer.provide(mockMcp({ defs: MINIMAL_DEFS, calls }))))

    it.effect("reports no capabilities and never calls tools", () =>
      Effect.gen(function* () {
        const bridge = yield* CodeFireBridge.Service
        calls.length = 0
        expect(yield* bridge.capabilities()).toEqual({ recall: false, capture: false, tasks: false })
        expect(yield* bridge.contextSearch("anything")).toBeUndefined()
        expect(yield* bridge.suggestWikiPages("anything")).toBeUndefined()
        expect(yield* bridge.listTasks("in_progress")).toBeUndefined()
        expect(yield* bridge.createNote({ title: "t", content: "c" })).toBe(false)
        expect(calls).toEqual([])
      }),
    )
  })

  describe("with failing bridge calls", () => {
    const it = testEffect(
      CodeFireBridge.layer.pipe(Layer.provide(mockMcp({ defs: FULL_DEFS, onCall: () => undefined }))),
    )

    it.effect("helpers degrade to undefined/false when callTool fails", () =>
      Effect.gen(function* () {
        const bridge = yield* CodeFireBridge.Service
        expect(yield* bridge.contextSearch("query")).toBeUndefined()
        expect(yield* bridge.createNote({ title: "t", content: "c" })).toBe(false)
      }),
    )
  })
})
