import { describe, expect, test } from "bun:test"
import { CodeFire } from "@/codefire/codefire"

describe("CodeFire product identity", () => {
  test("uses CodeFire-native labels for terminal chrome and user prompts", () => {
    expect(CodeFire.productName(["/usr/local/bin/codefire-agent"], {})).toBe("CodeFire")
    expect(CodeFire.terminalTitle(["/usr/local/bin/codefire-agent"], {})).toBe("CodeFire")
    expect(CodeFire.terminalTitle(["/usr/local/bin/codefire-agent"], {}, "Refactor SDK")).toBe("CF | Refactor SDK")
    expect(CodeFire.permissionRejectPlaceholder(["/usr/local/bin/codefire-agent"], {})).toBe(
      "Tell CodeFire what to do differently",
    )
  })

  test("preserves upstream labels for normal opencode launches", () => {
    expect(CodeFire.productName(["/usr/local/bin/opencode"], {})).toBe("OpenCode")
    expect(CodeFire.terminalTitle(["/usr/local/bin/opencode"], {})).toBe("OpenCode")
    expect(CodeFire.terminalTitle(["/usr/local/bin/opencode"], {}, "Refactor SDK")).toBe("OC | Refactor SDK")
    expect(CodeFire.permissionRejectPlaceholder(["/usr/local/bin/opencode"], {})).toBe(
      "Tell OpenCode what to do differently",
    )
  })
})
