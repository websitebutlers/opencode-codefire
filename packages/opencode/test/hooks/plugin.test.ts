import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { HooksPlugin } from "@/hooks/plugin"

async function setup(hooks: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-hooks-plugin-"))
  const instance = await HooksPlugin({ worktree: dir, directory: dir } as PluginInput)
  await instance.config?.({ hooks } as never)
  return { dir, instance: instance as Hooks }
}

async function waitFor(file: string, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      return await fs.readFile(file, "utf8")
    } catch {
      await Bun.sleep(25)
    }
  }
  throw new Error(`timed out waiting for ${file}`)
}

const before = (instance: Hooks, tool: string, args: Record<string, unknown> = {}) =>
  instance["tool.execute.before"]!({ tool, sessionID: "ses_1", callID: "call_1" }, { args })

const after = (instance: Hooks, tool: string, args: Record<string, unknown>, output: Record<string, unknown> = {}) =>
  instance["tool.execute.after"]!({ tool, sessionID: "ses_1", callID: "call_1", args }, {
    title: "",
    output: "",
    metadata: {},
    ...output,
  } as never)

describe("pre_tool hooks", () => {
  test("non-zero exit blocks with stderr in the error", async () => {
    const { instance } = await setup({
      pre_tool: [{ tools: ["bash"], command: `echo "no bash allowed" >&2; exit 1` }],
    })
    expect(before(instance, "bash", { command: "ls" })).rejects.toThrow(/no bash allowed/)
  })

  test("zero exit allows the call and receives payload on stdin", async () => {
    const { dir, instance } = await setup({
      pre_tool: [{ command: "cat > pre.json" }],
    })
    await before(instance, "edit", { filePath: "/w/a.ts" })
    const payload = JSON.parse(await waitFor(path.join(dir, "pre.json")))
    expect(payload.hook).toBe("pre_tool")
    expect(payload.tool).toBe("edit")
    expect(payload.args.filePath).toBe("/w/a.ts")
  })

  test("tools filter skips non-matching tools", async () => {
    const { instance } = await setup({
      pre_tool: [{ tools: ["bash"], command: "exit 1" }],
    })
    await before(instance, "edit")
  })

  test("unspawnable hook fails open", async () => {
    const { instance } = await setup({
      pre_tool: [{ command: "   " }],
    })
    await before(instance, "bash")
  })
})

describe("post_tool and file_edited hooks", () => {
  test("post_tool fires without blocking", async () => {
    const { dir, instance } = await setup({
      post_tool: [{ tools: ["edit"], command: "cat > post.json" }],
    })
    await after(instance, "edit", { filePath: "/w/a.ts" })
    const payload = JSON.parse(await waitFor(path.join(dir, "post.json")))
    expect(payload.hook).toBe("post_tool")
  })

  test("file_edited fires for matching globs with OPENCODE_HOOK_FILE", async () => {
    const { dir, instance } = await setup({
      file_edited: [{ glob: "*.ts", command: `echo "$OPENCODE_HOOK_FILE" > edited.txt` }],
    })
    await after(instance, "write", { filePath: path.join(dir, "src/index.ts") })
    expect((await waitFor(path.join(dir, "edited.txt"))).trim()).toBe(path.join(dir, "src/index.ts"))
  })

  test("file_edited skips non-matching globs", async () => {
    const { dir, instance } = await setup({
      file_edited: [{ glob: "*.py", command: "touch edited.txt" }],
    })
    await after(instance, "write", { filePath: path.join(dir, "src/index.ts") })
    await Bun.sleep(200)
    expect(fs.access(path.join(dir, "edited.txt"))).rejects.toThrow()
  })
})

describe("lifecycle hooks", () => {
  test("session_start fires for top-level sessions only", async () => {
    const { dir, instance } = await setup({
      session_start: [{ command: "cat > start.json" }],
    })
    await instance.event!({
      event: { type: "session.created", properties: { info: { id: "ses_sub", parentID: "ses_parent" } } },
    } as never)
    await instance.event!({
      event: { type: "session.created", properties: { info: { id: "ses_top" } } },
    } as never)
    const payload = JSON.parse(await waitFor(path.join(dir, "start.json")))
    expect(payload.sessionID).toBe("ses_top")
  })

  test("session_idle fires once on busy-to-idle transition", async () => {
    const { dir, instance } = await setup({
      session_idle: [{ command: `echo idle >> idle.txt` }],
    })
    const status = (sessionID: string, type: string) =>
      instance.event!({ event: { type: "session.status", properties: { sessionID, status: { type } } } } as never)
    await status("ses_1", "idle") // idle without prior busy: no fire
    await status("ses_1", "busy")
    await status("ses_1", "idle") // fires
    await status("ses_1", "idle") // no re-fire
    await waitFor(path.join(dir, "idle.txt"))
    await Bun.sleep(300)
    const lines = (await fs.readFile(path.join(dir, "idle.txt"), "utf8")).trim().split("\n")
    expect(lines).toHaveLength(1)
  })

  test("session_error fires with the event payload", async () => {
    const { dir, instance } = await setup({
      session_error: [{ command: "cat > error.json" }],
    })
    await instance.event!({
      event: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "Boom" } } },
    } as never)
    const payload = JSON.parse(await waitFor(path.join(dir, "error.json")))
    expect(payload.hook).toBe("session_error")
    expect(payload.event.error.name).toBe("Boom")
  })
})

describe("system prompt awareness", () => {
  test("appends the policy line only when pre_tool hooks exist", async () => {
    const { instance } = await setup({ pre_tool: [{ command: "exit 0" }] })
    const output = { system: [] as string[] }
    await instance["experimental.chat.system.transform"]!({} as never, output)
    expect(output.system.join("\n")).toContain("pre_tool")

    const { instance: bare } = await setup({})
    const none = { system: [] as string[] }
    await bare["experimental.chat.system.transform"]!({} as never, none)
    expect(none.system).toHaveLength(0)
  })
})
