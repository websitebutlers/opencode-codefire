import { describe, expect, test } from "bun:test"
import { Config } from "@/config/config"
import { ConfigParse } from "../../src/config/parse"

describe("codefire config block", () => {
  test("accepts recall and capture settings", () => {
    const parsed = ConfigParse.schema(
      Config.Info,
      {
        codefire: {
          recall: { enabled: false, budget: 4000, timeout: 1000 },
          capture: { enabled: true, max_notes: 2, min_turns: 5 },
        },
      },
      "test:config",
    )
    expect(parsed.codefire).toEqual({
      recall: { enabled: false, budget: 4000, timeout: 1000 },
      capture: { enabled: true, max_notes: 2, min_turns: 5 },
    })
  })

  test("codefire block is optional and partial", () => {
    expect(ConfigParse.schema(Config.Info, {}, "test:config").codefire).toBeUndefined()
    const parsed = ConfigParse.schema(Config.Info, { codefire: { recall: { enabled: true } } }, "test:config")
    expect(parsed.codefire?.recall?.enabled).toBe(true)
    expect(parsed.codefire?.capture).toBeUndefined()
  })
})
