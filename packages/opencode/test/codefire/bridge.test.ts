import { describe, expect, test } from "bun:test"
import { detectCapabilities, parseToolResultText } from "@/codefire/bridge"

describe("CodeFire bridge capabilities", () => {
  test("full desktop bridge unlocks recall, capture, and tasks", () => {
    const defs = [
      { name: "context_search" },
      { name: "suggest_wiki_pages" },
      { name: "get_wiki_page" },
      { name: "list_tasks" },
      { name: "create_note" },
    ]
    expect(detectCapabilities(defs)).toEqual({ recall: true, capture: true, tasks: true })
  })

  test("bundled minimal server has no capabilities", () => {
    expect(detectCapabilities([{ name: "codefire_info" }])).toEqual({ recall: false, capture: false, tasks: false })
  })

  test("missing defs (server not connected) means no capabilities", () => {
    expect(detectCapabilities(undefined)).toEqual({ recall: false, capture: false, tasks: false })
  })

  test("partial bridge maps tool presence to individual capabilities", () => {
    expect(detectCapabilities([{ name: "context_search" }])).toEqual({ recall: true, capture: false, tasks: false })
    expect(detectCapabilities([{ name: "create_note" }])).toEqual({ recall: false, capture: true, tasks: false })
    expect(detectCapabilities([{ name: "list_tasks" }])).toEqual({ recall: false, capture: false, tasks: true })
  })
})

describe("CodeFire bridge result parsing", () => {
  test("joins text content parts", () => {
    const result = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }
    expect(parseToolResultText(result)).toBe("first\nsecond")
  })

  test("ignores non-text content parts", () => {
    const result = {
      content: [
        { type: "image", data: "...", mimeType: "image/png" },
        { type: "text", text: "hello" },
      ],
    }
    expect(parseToolResultText(result)).toBe("hello")
  })

  test("returns undefined for error results", () => {
    expect(parseToolResultText({ isError: true, content: [{ type: "text", text: "boom" }] })).toBeUndefined()
  })

  test("returns undefined for empty or missing content", () => {
    expect(parseToolResultText({ content: [] })).toBeUndefined()
    expect(parseToolResultText(undefined)).toBeUndefined()
    expect(parseToolResultText({})).toBeUndefined()
  })

  test("returns undefined when text parts are all empty strings", () => {
    expect(parseToolResultText({ content: [{ type: "text", text: "" }] })).toBeUndefined()
  })
})
