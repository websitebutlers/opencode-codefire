import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"

describe("codefire-agent bin alias", () => {
  test("package.json exposes codefire-agent beside opencode", async () => {
    const pkg = await Bun.file(path.join(import.meta.dir, "../../package.json")).json()
    expect(pkg.bin.opencode).toBe("./bin/opencode")
    expect(pkg.bin["codefire-agent"]).toBe("./bin/opencode")
  })

  test("source node wrapper preserves codefire-agent invocation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codefire-agent-bin-"))
    try {
      const target = path.join(dir, "target.js")
      const alias = path.join(dir, process.platform === "win32" ? "codefire-agent.cmd" : "codefire-agent")

      await fs.writeFile(target, '#!/usr/bin/env node\nconsole.log(process.env.CODEFIRE_AGENT || "")\n')
      await fs.chmod(target, 0o755)
      await fs.symlink(path.join(import.meta.dir, "../../bin/opencode"), alias)

      const result = spawnSync(process.execPath, [alias], {
        encoding: "utf8",
        env: { ...process.env, OPENCODE_BIN_PATH: target },
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe("1")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("source node wrapper normalizes platform shim extensions", async () => {
    const wrapper = await Bun.file(path.join(import.meta.dir, "../../bin/opencode")).text()
    expect(wrapper).toContain('replace(/\\.(cmd|exe)$/i, "")')
  })

  test("publish script exposes the public codefire-agent package alias", async () => {
    const script = await Bun.file(path.join(import.meta.dir, "../../script/publish.ts")).text()
    expect(script).toContain('"codefire-agent": "./bin/codefire-agent"')
    expect(script).toContain('process.env.CODEFIRE_AGENT = "1"')
    expect(script).toContain('path.join(__dirname, "opencode.exe")')
  })
})
