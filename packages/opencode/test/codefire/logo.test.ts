import { describe, expect, test } from "bun:test"
import { UI } from "../../src/cli/ui"

describe("CodeFire logo", () => {
  test("renders the standalone CODEFIRE terminal agent wordmark without the flame glyph", () => {
    expect(UI.logo()).toBe(
      [
        "██████╗ ██████╗ ██████╗ ███████╗███████╗██╗██████╗ ███████╗",
        "██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██║██╔══██╗██╔════╝",
        "██║     ██║   ██║██║  ██║█████╗  █████╗  ██║██████╔╝█████╗  ",
        "██║     ██║   ██║██║  ██║██╔══╝  ██╔══╝  ██║██╔══██╗██╔══╝  ",
        "╚██████╗╚██████╔╝██████╔╝███████╗██║     ██║██║  ██║███████╗",
        " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝",
        "            ──── T E R M I N A L   A G E N T ────",
      ].join("\n"),
    )
  })
})
