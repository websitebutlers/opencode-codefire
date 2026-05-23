import { describe, expect, test } from "bun:test"
import path from "path"

describe("CodeFire prompt integration", () => {
  test("session prompt assembly includes CodeFire system instructions", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/session/prompt.ts")).text()
    expect(source).toContain('import { CodeFire } from "@/codefire/codefire"')
    expect(source).toContain("CodeFire.systemInstructions()")
    expect(source).toContain("...CodeFire.systemInstructions()")
  })
})
