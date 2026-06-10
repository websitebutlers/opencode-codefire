import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { blockMessage, execHook, extractEditedFiles, matchesGlob, matchesTool } from "@/hooks/exec"

const tmpdir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-hooks-"))
  return dir
}

describe("matchesTool", () => {
  test("undefined filters match every tool", () => {
    expect(matchesTool(undefined, "bash")).toBe(true)
  })
  test("exact and wildcard filters", () => {
    expect(matchesTool(["bash"], "bash")).toBe(true)
    expect(matchesTool(["bash"], "edit")).toBe(false)
    expect(matchesTool(["mcp_*"], "mcp_codefire_create_note")).toBe(true)
    expect(matchesTool(["edit", "write"], "write")).toBe(true)
  })
})

describe("matchesGlob", () => {
  test("undefined glob matches everything", () => {
    expect(matchesGlob(undefined, "/w/src/a.ts", "/w")).toBe(true)
  })
  test("matches against worktree-relative and absolute paths", () => {
    expect(matchesGlob("*.ts", "/w/src/index.ts", "/w")).toBe(true)
    expect(matchesGlob("src/*.ts", "/w/src/index.ts", "/w")).toBe(true)
    expect(matchesGlob("*.py", "/w/src/index.ts", "/w")).toBe(false)
  })
})

describe("blockMessage", () => {
  test("includes command and stderr", () => {
    const msg = blockMessage("./guard.sh", 1, "do not touch .env\n")
    expect(msg).toContain("./guard.sh")
    expect(msg).toContain("do not touch .env")
  })
  test("falls back to exit code when stderr empty and truncates long stderr", () => {
    expect(blockMessage("x", 3, "")).toContain("exited with code 3")
    expect(blockMessage("x", 1, "y".repeat(5000)).length).toBeLessThan(2300)
  })
})

describe("extractEditedFiles", () => {
  test("edit and write use args.filePath", () => {
    expect(extractEditedFiles("edit", { filePath: "/w/a.ts" }, {})).toEqual(["/w/a.ts"])
    expect(extractEditedFiles("write", { filePath: "/w/b.ts" }, {})).toEqual(["/w/b.ts"])
  })
  test("apply_patch uses output metadata files", () => {
    const output = { metadata: { files: [{ filePath: "/w/a.ts" }, { filePath: "/w/b.ts" }] } }
    expect(extractEditedFiles("apply_patch", {}, output)).toEqual(["/w/a.ts", "/w/b.ts"])
  })
  test("other tools yield nothing", () => {
    expect(extractEditedFiles("bash", { command: "rm a.ts" }, {})).toEqual([])
  })
})

describe("execHook", () => {
  test("runs the command in cwd with env and stdin payload", async () => {
    const dir = await tmpdir()
    const result = await execHook({
      command: `cat > marker.json && echo "$OPENCODE_HOOK" > hook.txt`,
      cwd: dir,
      env: { OPENCODE_HOOK: "pre_tool" },
      payload: { hook: "pre_tool", tool: "bash" },
      timeout: 5000,
    })
    expect(result).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(await fs.readFile(path.join(dir, "marker.json"), "utf8"))).toEqual({
      hook: "pre_tool",
      tool: "bash",
    })
    expect((await fs.readFile(path.join(dir, "hook.txt"), "utf8")).trim()).toBe("pre_tool")
  })

  test("propagates non-zero exit codes and stderr", async () => {
    const dir = await tmpdir()
    const result = await execHook({
      command: `echo "nope" >&2; exit 3`,
      cwd: dir,
      env: {},
      payload: {},
      timeout: 5000,
    })
    expect(result).toEqual({ code: 3, stderr: "nope\n" })
  })

  test("times out long-running hooks as a failure", async () => {
    const dir = await tmpdir()
    const start = Date.now()
    const result = await execHook({
      command: "sleep 60",
      cwd: dir,
      env: {},
      payload: {},
      timeout: 500,
    })
    expect(Date.now() - start).toBeLessThan(10_000)
    expect("failed" in result).toBe(true)
  })

  test("reports unspawnable commands as a failure", async () => {
    const dir = await tmpdir()
    const result = await execHook({
      command: "",
      cwd: dir,
      env: {},
      payload: {},
      timeout: 1000,
    })
    expect("failed" in result).toBe(true)
  })
})
