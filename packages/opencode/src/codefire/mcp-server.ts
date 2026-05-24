import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

/**
 * Minimal bundled MCP server shipped inside @codefireapp/agent so the CLI has a
 * working MCP entry out of the box, even when the user has not installed the
 * full CodeFire Desktop App bridge (`codefire mcp`). Exposes a single
 * `codefire_info` tool that tells the user how to unlock the rich feature set
 * (wiki, tasks, notes, context_search, agent handoffs).
 *
 * When the agent detects an external `codefire` binary on PATH, that takes
 * precedence and this server is never spawned — see CodeFireMCP.ensureAutoRegistered.
 *
 * Returns a Promise that resolves only when the stdio transport closes
 * (i.e. the MCP client disconnects or stdin reaches EOF). This keeps the host
 * CLI process alive for the duration of the MCP session.
 */
export async function startMinimalMcpServer() {
  const server = new Server(
    { name: "codefire-agent-bundled", version: InstallationVersion },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "codefire_info",
        description:
          "Display information about the CodeFire Terminal Agent setup, including how to enable the full CodeFire MCP feature set (wiki, tasks, notes, context_search, agent handoffs).",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "codefire_info") {
      return {
        content: [
          {
            type: "text",
            text: [
              `CodeFire Terminal Agent v${InstallationVersion}`,
              "",
              "This is the minimal bundled MCP server shipped with @codefireapp/agent.",
              "It currently exposes only this `codefire_info` tool.",
              "",
              "For the full CodeFire MCP feature set — wiki pages, tasks, notes, semantic",
              "context_search, and agent handoffs — install the CodeFire Desktop App from",
              "https://codefire.app. It provides the richer `codefire mcp` bridge; the agent",
              "will detect it on PATH and use it instead of this stub on next launch.",
            ].join("\n"),
          },
        ],
      }
    }
    throw new Error(`Unknown tool: ${request.params.name}`)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    const done = () => resolve()
    transport.onclose = done
    process.stdin.once("end", done)
    process.stdin.once("close", done)
  })
}
