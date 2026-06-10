import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { formatRecallBlock, CodeFireRecall } from "@/codefire/recall"
import { CodeFireBridge } from "@/codefire/bridge"
import { testEffect } from "../lib/effect"

describe("formatRecallBlock", () => {
  test("returns undefined when all sections are empty", () => {
    expect(formatRecallBlock({ budget: 8000 })).toBeUndefined()
    expect(formatRecallBlock({ wiki: "", search: "", tasks: "", budget: 8000 })).toBeUndefined()
  })

  test("wraps content in a codefire-context block with section headers", () => {
    const block = formatRecallBlock({
      wiki: "Page: Agent Harness",
      search: "src/foo.ts: does things",
      tasks: "#12 Fix login",
      budget: 8000,
    })
    expect(block).toBeDefined()
    expect(block).toStartWith("<codefire-context>")
    expect(block).toEndWith("</codefire-context>")
    expect(block).toContain("Page: Agent Harness")
    expect(block).toContain("src/foo.ts: does things")
    expect(block).toContain("#12 Fix login")
    expect(block).toContain("## Wiki")
    expect(block).toContain("## Code search")
    expect(block).toContain("## In-progress tasks")
  })

  test("omits empty sections", () => {
    const block = formatRecallBlock({ wiki: "only wiki", budget: 8000 })
    expect(block).toContain("## Wiki")
    expect(block).not.toContain("## Code search")
    expect(block).not.toContain("## In-progress tasks")
  })

  test("enforces the total character budget by truncating sections", () => {
    const block = formatRecallBlock({
      wiki: "w".repeat(10_000),
      search: "s".repeat(10_000),
      tasks: "t".repeat(10_000),
      budget: 3000,
    })
    expect(block).toBeDefined()
    expect(block!.length).toBeLessThanOrEqual(3000)
    // every section still gets some share of the budget
    expect(block).toContain("w")
    expect(block).toContain("s")
    expect(block).toContain("t")
  })
})

describe("CodeFireRecall.fetch", () => {
  const mockBridge = (input: { wiki?: string; search?: string; tasks?: string }) =>
    Layer.mock(CodeFireBridge.Service)({
      capabilities: () =>
        Effect.succeed({
          recall: input.wiki !== undefined || input.search !== undefined,
          capture: false,
          tasks: input.tasks !== undefined,
        }),
      suggestWikiPages: () => Effect.succeed(input.wiki),
      contextSearch: () => Effect.succeed(input.search),
      listTasks: () => Effect.succeed(input.tasks),
    })

  describe("with a full bridge", () => {
    const it = testEffect(
      CodeFireRecall.layer.pipe(
        Layer.provide(mockBridge({ wiki: "wiki snippet", search: "search hit", tasks: "task title" })),
      ),
    )

    it.effect("composes all sections into one block", () =>
      Effect.gen(function* () {
        const recall = yield* CodeFireRecall.Service
        const block = yield* recall.fetch("how does auth work", { budget: 8000 })
        expect(block).toContain("wiki snippet")
        expect(block).toContain("search hit")
        expect(block).toContain("task title")
      }),
    )
  })

  describe("with a degraded bridge", () => {
    const it = testEffect(CodeFireRecall.layer.pipe(Layer.provide(mockBridge({}))))

    it.effect("returns undefined without failing", () =>
      Effect.gen(function* () {
        const recall = yield* CodeFireRecall.Service
        expect(yield* recall.fetch("anything", { budget: 8000 })).toBeUndefined()
      }),
    )
  })
})
