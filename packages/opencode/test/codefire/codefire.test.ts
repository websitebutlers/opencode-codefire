import { describe, expect, test } from "bun:test"
import { CodeFire } from "@/codefire/codefire"

describe("CodeFire", () => {
  test("does not enable CodeFire mode for normal opencode launches", () => {
    expect(CodeFire.detect(["/usr/local/bin/opencode"], {}).mode).toBe("normal")
    expect(CodeFire.systemInstructions(["/usr/local/bin/opencode"], {})).toEqual([])
  })

  test("detects the codefire-agent binary name", () => {
    const runtime = CodeFire.detect(["/usr/local/bin/codefire-agent"], {})
    expect(runtime.mode).toBe("terminal")
    expect(runtime.cliName).toBe("codefire-agent")
  })

  test("detects explicit CodeFire profile env", () => {
    const runtime = CodeFire.detect(["/usr/local/bin/opencode"], { CODEFIRE_AGENT: "1" })
    expect(runtime.mode).toBe("terminal")
    expect(runtime.cliName).toBe("codefire-agent")
  })

  test("detects Agent Chat mode from CodeFire metadata", () => {
    const runtime = CodeFire.detect(["/usr/local/bin/opencode"], {
      CODEFIRE_AGENT: "1",
      CODEFIRE_AGENT_CHAT: "1",
      CODEFIRE_PROJECT_ID: "43b39618-0636-4cd6-ac25-23e7798392fc",
      CODEFIRE_PARENT_THREAD_ID: "150",
      CODEFIRE_HANDOFF_TITLE: "Build CodeFire agent harness",
    })

    expect(runtime.mode).toBe("agent-chat")
    expect(runtime.projectID).toBe("43b39618-0636-4cd6-ac25-23e7798392fc")
    expect(runtime.parentThreadID).toBe(150)
    expect(runtime.handoffTitle).toBe("Build CodeFire agent harness")
  })

  test("includes CodeFire MCP orientation in generated system instructions", () => {
    const instructions = CodeFire.systemInstructions(["/usr/local/bin/codefire-agent"], {
      CODEFIRE_PROJECT_ID: "project-1",
      CODEFIRE_PARENT_THREAD_ID: "150",
    })

    expect(instructions).toHaveLength(1)
    expect(instructions[0]).toContain("CodeFire Agent Harness")
    expect(instructions[0]).toContain("get_current_project")
    expect(instructions[0]).toContain("context_search")
    expect(instructions[0]).toContain("agent_request_handoff")
    expect(instructions[0]).toContain("project-1")
    expect(instructions[0]).toContain("150")
  })
})
