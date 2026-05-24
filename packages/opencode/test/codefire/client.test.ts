import { describe, expect, test } from "bun:test"
import { CodeFireAgentClientError, createCodeFireAgentClient } from "@opencode-ai/sdk/codefire"

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })
}

describe("CodeFire Desktop client", () => {
  test("fetches typed CodeFire control endpoints from the configured base URL", async () => {
    const calls: Array<{ url: string; accept: string | null; authorization: string | null }> = []
    const client = createCodeFireAgentClient({
      baseUrl: "http://127.0.0.1:4096/",
      headers: {
        authorization: "Basic test",
      },
      fetch: async (request) => {
        const next = request instanceof Request ? request : new Request(request)
        calls.push({
          url: next.url,
          accept: next.headers.get("accept"),
          authorization: next.headers.get("authorization"),
        })
        return json({
          schemaVersion: 1,
          product: { name: "CodeFire Terminal Agent", binary: "codefire-agent" },
          api: { basePath: "/codefire/v1" },
        })
      },
    })

    const manifest = await client.manifest()

    expect(manifest.product.name).toBe("CodeFire Terminal Agent")
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:4096/codefire/v1/manifest",
        accept: "application/json",
        authorization: "Basic test",
      },
    ])
  })

  test("builds a GUI-ready snapshot from all CodeFire control endpoints", async () => {
    const paths: string[] = []
    const client = createCodeFireAgentClient({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        const url = new URL(request instanceof Request ? request.url : String(request))
        paths.push(url.pathname)
        return json({
          schemaVersion: 1,
          path: url.pathname,
        })
      },
    })

    const snapshot = await client.snapshot()

    expect(paths).toEqual([
      "/codefire/v1/manifest",
      "/codefire/v1/health",
      "/codefire/v1/models",
      "/codefire/v1/settings",
      "/codefire/v1/connections",
      "/codefire/v1/mcp",
      "/codefire/v1/lifecycle",
    ])
    expect(snapshot.connections.path).toBe("/codefire/v1/connections")
    expect(snapshot.lifecycle.path).toBe("/codefire/v1/lifecycle")
  })

  test("throws a structured error for failed CodeFire control requests", async () => {
    const client = createCodeFireAgentClient({
      baseUrl: "http://localhost",
      fetch: async () => json({ error: "unauthorized" }, 401),
    })

    await expect(client.health()).rejects.toMatchObject({
      name: "CodeFireAgentClientError",
      status: 401,
      path: "/codefire/v1/health",
      body: { error: "unauthorized" },
    })

    await client.health().catch((error) => {
      expect(error).toBeInstanceOf(CodeFireAgentClientError)
    })
  })

  test("types provider connections as redacted readiness only", async () => {
    const client = createCodeFireAgentClient({
      baseUrl: "http://localhost",
      fetch: async () =>
        json({
          schemaVersion: 1,
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              status: "connected",
              source: "models.dev",
              auth: {
                env: true,
                stored: false,
                config: false,
              },
            },
          ],
        }),
    })

    const connections = await client.connections()

    expect(connections.providers[0]).toEqual({
      id: "anthropic",
      name: "Anthropic",
      status: "connected",
      source: "models.dev",
      auth: {
        env: true,
        stored: false,
        config: false,
      },
    })
    expect(JSON.stringify(connections)).not.toContain("key")
    expect(JSON.stringify(connections)).not.toContain("token")
  })
})
