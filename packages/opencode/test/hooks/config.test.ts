import { describe, expect, test } from "bun:test"
import { Config } from "@/config/config"
import { ConfigParse } from "../../src/config/parse"

describe("hooks config block", () => {
  test("accepts all hook event arrays", () => {
    const parsed = ConfigParse.schema(
      Config.Info,
      {
        hooks: {
          pre_tool: [{ command: "./guard.sh", tools: ["bash", "mcp_*"], timeout: 5000 }],
          post_tool: [{ command: "echo done", tools: ["edit"] }],
          file_edited: [{ command: 'bunx prettier --write "$OPENCODE_HOOK_FILE"', glob: "*.ts" }],
          session_start: [{ command: "echo start" }],
          session_idle: [{ command: "osascript -e 'display notification \"idle\"'" }],
          session_error: [{ command: "echo error" }],
        },
      },
      "test:config",
    )
    expect(parsed.hooks?.pre_tool?.[0]?.command).toBe("./guard.sh")
    expect(parsed.hooks?.pre_tool?.[0]?.tools).toEqual(["bash", "mcp_*"])
    expect(parsed.hooks?.pre_tool?.[0]?.timeout).toBe(5000)
    expect(parsed.hooks?.file_edited?.[0]?.glob).toBe("*.ts")
    expect(parsed.hooks?.session_idle).toHaveLength(1)
  })

  test("hooks block is optional", () => {
    expect(ConfigParse.schema(Config.Info, {}, "test:config").hooks).toBeUndefined()
  })
})

describe("schedules config block", () => {
  test("accepts interval and daily-time schedules", () => {
    const parsed = ConfigParse.schema(
      Config.Info,
      {
        schedules: [
          { name: "standup", at: "09:00", prompt: "Summarize open tasks", agent: "plan" },
          { name: "lint", every: "4h", prompt: "Run the linter and fix issues", model: "anthropic/claude-sonnet-4-6" },
          { name: "off", every: "30m", prompt: "noop", enabled: false },
        ],
      },
      "test:config",
    )
    expect(parsed.schedules).toHaveLength(3)
    expect(parsed.schedules?.[0]?.at).toBe("09:00")
    expect(parsed.schedules?.[1]?.every).toBe("4h")
    expect(parsed.schedules?.[1]?.model).toBe("anthropic/claude-sonnet-4-6")
    expect(parsed.schedules?.[2]?.enabled).toBe(false)
  })
})
