import { describe, expect, test } from "bun:test"
import { UI } from "../../src/cli/ui"

describe("CodeFire logo", () => {
  test("renders the CODEFIRE terminal agent wordmark for non-interactive help output", () => {
    expect(UI.logo()).toContain("██████╗ ██████╗ ██████╗ ███████╗███████╗██╗██████╗ ███████╗")
    expect(UI.logo()).toContain("──── T E R M I N A L   A G E N T ────")
  })
})
