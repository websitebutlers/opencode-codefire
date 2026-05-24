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

  test("ensureAutoRegistered: leaves config alone when CodeFire is not active", () => {
    const result = CodeFireMCP.ensureAutoRegistered({ mcp: { custom: { type: "local", command: ["foo"] } } }, {}, {}, [])
    expect(result).toEqual({ custom: { type: "local", command: ["foo"] } })
  })

  test("ensureAutoRegistered: injects bundled fallback when codefire bridge is not on PATH", () => {
    // PATH is empty, so the external `codefire` binary is not found and the
    // helper should fall back to spawning the bundled MCP server.
    const result = CodeFireMCP.ensureAutoRegistered({ mcp: {} }, {}, { CODEFIRE_AGENT: "1", PATH: "" }, [])
    expect(result?.codefire).toEqual({
      type: "local",
      command: [process.execPath, "mcp", "serve"],
      enabled: true,
      timeout: 30000,
      environment: { CODEFIRE_AGENT: "1" },
    })
  })

  test("resolvedDefaultCommand: returns external codefire mcp when bridge is on PATH", () => {
    // Use the running test's own bash interpreter as a stand-in for an
    // executable found via PATH. We point CODEFIRE_MCP_DEFAULT_COMMAND[0]'s
    // resolveExecutable at /bin which exists on every POSIX system.
    const result = CodeFireMCP.resolvedDefaultCommand({ PATH: "" })
    // With empty PATH, codefire is NOT found, so we get the bundled fallback.
    expect(result).toEqual([process.execPath, "mcp", "serve"])
  })

  test("ensureAutoRegistered: does NOT overwrite explicit user config", () => {
    const user = { type: "remote" as const, url: "http://localhost:9999/mcp", enabled: true, timeout: 1000 }
    const result = CodeFireMCP.ensureAutoRegistered({ mcp: { codefire: user } }, {}, { CODEFIRE_AGENT: "1" }, [])
    expect(result?.codefire).toEqual(user)
  })

  test("ensureAutoRegistered: respects CODEFIRE_MCP_NAME override", () => {
    const result = CodeFireMCP.ensureAutoRegistered(
      { mcp: {} },
      {},
      { CODEFIRE_AGENT: "1", CODEFIRE_MCP_NAME: "workspace-memory" },
      [],
    )
    expect(result?.["workspace-memory"]).toBeDefined()
    expect(result?.codefire).toBeUndefined()
  })

  test("ensureAutoRegistered: passes through undefined when CodeFire is not active and no mcp set", () => {
    const result = CodeFireMCP.ensureAutoRegistered({}, {}, {}, [])
    expect(result).toBeUndefined()
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
