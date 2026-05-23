import { describe, expect, test } from "bun:test"
import { CodeFireMCP } from "@/codefire/mcp"

describe("CodeFire MCP bootstrap", () => {
  test("uses the default CodeFire MCP server name", () => {
    expect(CodeFireMCP.mcpName({})).toBe("codefire")
    expect(CodeFireMCP.mcpName({ CODEFIRE_MCP_NAME: "workspace-memory" })).toBe("workspace-memory")
  })

  test("parses shell-style local command strings", () => {
    expect(CodeFireMCP.splitCommand('codefire mcp --profile "Agent Chat"')).toEqual([
      "codefire",
      "mcp",
      "--profile",
      "Agent Chat",
    ])
  })

  test("parses JSON argv command strings", () => {
    expect(CodeFireMCP.splitCommand('["node","server.js","--stdio"]')).toEqual(["node", "server.js", "--stdio"])
  })

  test("builds a local bootstrap config from env command", () => {
    const config = CodeFireMCP.bootstrapConfig(
      {},
      {
        CODEFIRE_MCP_COMMAND: 'codefire mcp --project "abc"',
        CODEFIRE_PROJECT_ID: "project-1",
        CODEFIRE_PARENT_THREAD_ID: "150",
      },
    )

    expect(config).toEqual({
      type: "local",
      command: ["codefire", "mcp", "--project", "abc"],
      enabled: true,
      timeout: 30000,
      environment: {
        CODEFIRE_AGENT: "1",
        CODEFIRE_PROJECT_ID: "project-1",
        CODEFIRE_PARENT_THREAD_ID: "150",
      },
    })
  })

  test("builds a remote bootstrap config from URL", () => {
    expect(CodeFireMCP.bootstrapConfig({ url: "http://127.0.0.1:49200/mcp" }, {})).toEqual({
      type: "remote",
      url: "http://127.0.0.1:49200/mcp",
      enabled: true,
      timeout: 30000,
    })
  })

  test("diagnoses missing config", () => {
    const checks = CodeFireMCP.diagnostics({ mcp: {} }, "codefire", { CODEFIRE_AGENT: "1" })
    expect(checks.some((check) => check.status === "fail" && check.label === "config")).toBe(true)
  })

  test("diagnoses a configured local command", () => {
    const checks = CodeFireMCP.diagnostics(
      {
        mcp: {
          codefire: {
            type: "local",
            command: ["definitely-not-codefire-mcp"],
          },
        },
      },
      "codefire",
      { CODEFIRE_AGENT: "1", PATH: "" },
    )

    expect(checks).toContainEqual({
      status: "fail",
      label: "command",
      detail: "definitely-not-codefire-mcp is not executable from PATH",
    })
  })
})
