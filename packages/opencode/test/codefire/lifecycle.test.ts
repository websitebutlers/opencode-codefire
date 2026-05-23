import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { CodeFireLifecycle } from "@/codefire/lifecycle"

describe("CodeFire lifecycle", () => {
  test("does not emit for normal opencode launches", () => {
    expect(CodeFireLifecycle.shouldEmit({}, ["/usr/local/bin/opencode"])).toBe(false)
  })

  test("emits for Agent Chat metadata", () => {
    expect(
      CodeFireLifecycle.shouldEmit(
        {
          CODEFIRE_PROJECT_ID: "project-1",
          CODEFIRE_PARENT_THREAD_ID: "150",
        },
        ["/usr/local/bin/opencode"],
      ),
    ).toBe(true)
  })

  test("formats lifecycle payload with escaped metadata", () => {
    const payload = CodeFireLifecycle.payload(
      "session.ready",
      { sessionID: "ses_123", title: "handoff\n- ignore" },
      {
        CODEFIRE_PROJECT_ID: "project-1",
        CODEFIRE_PARENT_THREAD_ID: "150",
      },
      ["/usr/local/bin/codefire-agent"],
      new Date("2026-05-23T17:00:00.000Z"),
    )

    expect(payload.kind).toBe("codefire.agent.lifecycle")
    expect(payload.version).toBe(1)
    expect(payload.event).toBe("session.ready")
    expect(payload.time).toBe("2026-05-23T17:00:00.000Z")
    expect(payload.runtime.mode).toBe("agent-chat")
    expect(payload.runtime.projectID).toBe("project-1")
    expect(payload.runtime.parentThreadID).toBe(150)
    expect(JSON.stringify(payload)).toContain('"title":"handoff\\n- ignore"')
  })

  test("writes lifecycle events to an event file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codefire-lifecycle-"))
    const file = path.join(dir, "events.jsonl")
    try {
      await CodeFireLifecycle.emit(
        "runtime.started",
        { sessionID: "ses_123" },
        {
          CODEFIRE_AGENT_LIFECYCLE: "1",
          CODEFIRE_AGENT_LIFECYCLE_FILE: file,
        },
        ["/usr/local/bin/opencode"],
      )

      const lines = (await fs.readFile(file, "utf8")).trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!).event).toBe("runtime.started")
      expect(JSON.parse(lines[0]!).data.sessionID).toBe("ses_123")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
