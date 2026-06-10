import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/core/session-message"
import { subagentResultText } from "../../src/v2/session"

const messages = (...items: unknown[]) => items as SessionMessage.Message[]

describe("v2.subagentResultText", () => {
  test("returns the last text part of the first assistant message", () => {
    const result = subagentResultText(
      messages(
        {
          type: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "tool" },
            { type: "text", text: "final answer" },
          ],
        },
        { type: "user" },
      ),
    )

    expect(result).toBe("final answer")
  })

  test("returns undefined when there is no assistant message", () => {
    expect(subagentResultText(messages({ type: "user" }))).toBeUndefined()
  })

  test("returns undefined when the assistant message has no text part", () => {
    expect(subagentResultText(messages({ type: "assistant", content: [{ type: "tool" }] }))).toBeUndefined()
  })
})
