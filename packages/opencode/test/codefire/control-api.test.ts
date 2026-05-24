import { afterEach, describe, expect } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { it } from "../lib/effect"
import { Effect } from "effect"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("CodeFire control API", () => {
  it.live(
    "serves a versioned manifest for desktop discovery",
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => Promise.resolve(app().request("/codefire/v1/manifest")))

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        schemaVersion: 1,
        product: {
          name: "CodeFire Terminal Agent",
          binary: "codefire-agent",
          engine: {
            name: "opencode",
          },
        },
        runtime: {
          mode: "terminal",
        },
        api: {
          basePath: "/codefire/v1",
          endpoints: [
            "/codefire/v1/manifest",
            "/codefire/v1/health",
            "/codefire/v1/models",
            "/codefire/v1/settings",
            "/codefire/v1/connections",
            "/codefire/v1/mcp",
            "/codefire/v1/lifecycle",
          ],
        },
        capabilities: {
          controlApi: true,
          health: true,
          manifest: true,
          models: true,
          settings: true,
          connections: true,
          mcp: true,
        },
      })
    }),
  )

  it.live(
    "serves health checks for desktop readiness",
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => Promise.resolve(app().request("/codefire/v1/health")))

      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body).toMatchObject({
        schemaVersion: 1,
        status: "ok",
        runtime: {
          mode: "terminal",
        },
      })
      expect(body.checks).toContainEqual({
        id: "runtime",
        status: "pass",
        message: "CodeFire terminal agent runtime is active",
      })
      expect(body.checks).toContainEqual({
        id: "control-api",
        status: "pass",
        message: "CodeFire control API is available",
      })
    }),
  )

  it.live(
    "serves model catalog metadata for desktop configuration",
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => Promise.resolve(app().request("/codefire/v1/models")))

      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body).toMatchObject({
        schemaVersion: 1,
        defaults: expect.any(Object),
      })
      expect(Array.isArray(body.providers)).toBe(true)
      expect(body.providers.length).toBeGreaterThan(0)
      expect(body.providers[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          modelCount: expect.any(Number),
        }),
      )
    }),
  )

  it.live(
    "serves redacted settings for desktop configuration",
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => Promise.resolve(app().request("/codefire/v1/settings")))

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        schemaVersion: 1,
        defaults: {
          model: null,
          smallModel: null,
          agent: "build",
        },
        behavior: {
          autoupdate: true,
          share: "manual",
        },
        paths: {
          config: expect.any(String),
          data: expect.any(String),
          state: expect.any(String),
          cache: expect.any(String),
        },
      })
    }),
  )

  it.live(
    "serves redacted connection readiness for desktop configuration",
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => Promise.resolve(app().request("/codefire/v1/connections")))

      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body).toMatchObject({
        schemaVersion: 1,
      })
      expect(Array.isArray(body.providers)).toBe(true)
      expect(body.providers.length).toBeGreaterThan(0)
      expect(body.providers[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          status: expect.stringMatching(/^(available|connected)$/),
          auth: {
            env: expect.any(Boolean),
            stored: expect.any(Boolean),
            config: expect.any(Boolean),
          },
        }),
      )
      expect(JSON.stringify(body)).not.toContain("sk-")
    }),
  )

  it.live(
    "serves CodeFire MCP readiness and project context",
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        withEnv(
          {
            CODEFIRE_PROJECT_ID: "43b39618-0636-4cd6-ac25-23e7798392fc",
            CODEFIRE_PARENT_THREAD_ID: "150",
          },
          () => Promise.resolve(app().request("/codefire/v1/mcp")),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        schemaVersion: 1,
        name: "codefire",
        configured: false,
        enabled: false,
        transport: null,
        status: "missing",
        toolCount: null,
        project: {
          id: "43b39618-0636-4cd6-ac25-23e7798392fc",
          parentThreadID: 150,
          mode: "agent-chat",
        },
        checks: expect.arrayContaining([
          {
            status: "fail",
            label: "config",
            detail: 'No MCP server named "codefire" is configured',
          },
        ]),
      })
    }),
  )

  it.live(
    "serves lifecycle contract metadata for Agent Chat clients",
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        withEnv(
          {
            CODEFIRE_PROJECT_ID: "43b39618-0636-4cd6-ac25-23e7798392fc",
            CODEFIRE_PARENT_THREAD_ID: "150",
            CODEFIRE_AGENT_LIFECYCLE_FILE: "/tmp/codefire-agent-events.jsonl",
          },
          () => Promise.resolve(app().request("/codefire/v1/lifecycle")),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        schemaVersion: 1,
        enabled: true,
        payload: {
          kind: "codefire.agent.lifecycle",
          version: 1,
        },
        sink: {
          type: "file",
          path: "/tmp/codefire-agent-events.jsonl",
          format: "jsonl",
        },
        runtime: {
          mode: "agent-chat",
          projectID: "43b39618-0636-4cd6-ac25-23e7798392fc",
          parentThreadID: 150,
        },
        events: [
          "runtime.started",
          "session.ready",
          "session.new",
          "session.closed",
          "runtime.closed",
        ],
      })
    }),
  )
})
