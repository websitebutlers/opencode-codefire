import { describe, expect, test } from "bun:test"
import { buildExtractionPrompt, dedupeNotes, fingerprint, parseNotes, selectTranscript } from "@/codefire/capture"

describe("parseNotes", () => {
  test("parses numbered notes with title :: content separator", () => {
    const output = [
      "1. Zombie processes from Process() :: Use spawn helpers instead; Process() in timers leaks children.",
      "2. Config lives in JSONC :: opencode.json supports comments and is schema-validated.",
    ].join("\n")
    expect(parseNotes(output)).toEqual([
      {
        title: "Zombie processes from Process()",
        content: "Use spawn helpers instead; Process() in timers leaks children.",
      },
      {
        title: "Config lives in JSONC",
        content: "opencode.json supports comments and is schema-validated.",
      },
    ])
  })

  test("accepts dash bullets and falls back to derived titles", () => {
    const notes = parseNotes("- The MCP defs cache is invalidated on tools-changed events and reconnects")
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toBe("The MCP defs cache is invalidated on tools-changed events and reconnects")
    expect(notes[0]!.title.length).toBeGreaterThan(0)
    expect(notes[0]!.title.length).toBeLessThanOrEqual(80)
  })

  test("returns empty for NONE", () => {
    expect(parseNotes("NONE")).toEqual([])
    expect(parseNotes("  none  ")).toEqual([])
  })

  test("ignores surrounding chatter and unmarked lines", () => {
    const output = ["Here are the durable findings:", "1. Real note :: with content", "Hope that helps!"].join("\n")
    expect(parseNotes(output)).toEqual([{ title: "Real note", content: "with content" }])
  })

  test("returns empty for garbage", () => {
    expect(parseNotes("")).toEqual([])
    expect(parseNotes("I could not find anything durable in this session.")).toEqual([])
  })
})

describe("fingerprint", () => {
  test("is stable across whitespace and case differences", () => {
    const a = fingerprint({ title: "Zombie Processes", content: "Use   spawn helpers." })
    const b = fingerprint({ title: "zombie processes", content: "use spawn helpers." })
    expect(a).toBe(b)
  })

  test("differs for different content", () => {
    expect(fingerprint({ title: "A", content: "one" })).not.toBe(fingerprint({ title: "A", content: "two" }))
  })
})

describe("selectTranscript", () => {
  const msg = (id: string, role: "user" | "assistant", text: string, synthetic = false) => ({
    info: { id, role },
    parts: [{ type: "text" as const, text, synthetic }],
  })

  test("extracts user and assistant text in order", () => {
    const result = selectTranscript([msg("m1", "user", "question"), msg("m2", "assistant", "answer")])
    expect(result.transcript).toEqual([
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
    ])
    expect(result.newUserTurns).toBe(1)
    expect(result.lastMessageID).toBe("m2")
  })

  test("only considers messages after lastMessageID", () => {
    const messages = [
      msg("m1", "user", "old question"),
      msg("m2", "assistant", "old answer"),
      msg("m3", "user", "new question"),
    ]
    const result = selectTranscript(messages, "m2")
    expect(result.transcript).toEqual([{ role: "user", text: "new question" }])
    expect(result.newUserTurns).toBe(1)
    expect(result.lastMessageID).toBe("m3")
  })

  test("ignores synthetic parts when counting user turns", () => {
    const result = selectTranscript([msg("m1", "user", "<codefire-context>...</codefire-context>", true)])
    expect(result.newUserTurns).toBe(0)
    expect(result.transcript).toEqual([])
  })

  test("returns empty for unknown lastMessageID beyond the history", () => {
    const result = selectTranscript([msg("m1", "user", "q")], "zzz_unknown")
    // unknown id means nothing newer is known — fall back to everything
    expect(result.transcript).toEqual([{ role: "user", text: "q" }])
  })
})

describe("dedupeNotes", () => {
  test("drops notes whose fingerprint is already known and caps at maxNotes", () => {
    const known = new Set([fingerprint({ title: "Known", content: "fact" })])
    const result = dedupeNotes(
      [
        { title: "Known", content: "fact" },
        { title: "Fresh A", content: "a" },
        { title: "Fresh B", content: "b" },
        { title: "Fresh C", content: "c" },
      ],
      known,
      2,
    )
    expect(result).toEqual([
      { title: "Fresh A", content: "a" },
      { title: "Fresh B", content: "b" },
    ])
  })

  test("dedupes within the same batch", () => {
    const result = dedupeNotes(
      [
        { title: "Same", content: "thing" },
        { title: "same", content: "  thing " },
      ],
      new Set(),
      5,
    )
    expect(result).toHaveLength(1)
  })
})

describe("buildExtractionPrompt", () => {
  test("includes the transcript and the NONE escape hatch", () => {
    const prompt = buildExtractionPrompt([
      { role: "user", text: "why does the build fail?" },
      { role: "assistant", text: "turbo cache was stale" },
    ])
    expect(prompt).toContain("why does the build fail?")
    expect(prompt).toContain("turbo cache was stale")
    expect(prompt).toContain("NONE")
    expect(prompt).toContain("::")
  })
})
