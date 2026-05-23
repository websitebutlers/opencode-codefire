import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  generatedCodeFireAgentWrapper,
  generatedPostinstallSkippedPlaceholder,
  generatedPublicPackage,
} from "../../script/publish-package"

describe("codefire-agent bin alias", () => {
  test("package.json exposes codefire-agent beside opencode", async () => {
    const pkg = await Bun.file(path.join(import.meta.dir, "../../package.json")).json()
    expect(pkg.bin.opencode).toBe("./bin/opencode")
    expect(pkg.bin["codefire-agent"]).toBe("./bin/codefire-agent")
  })

  test("dedicated source wrapper propagates codefire-agent mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codefire-agent-bin-"))
    try {
      const target = path.join(dir, "target.js")

      await fs.writeFile(
        target,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({",
          "  codefireAgent: process.env.CODEFIRE_AGENT,",
          "  argv: process.argv.slice(2),",
          "  xdgData: process.env.XDG_DATA_HOME,",
          "  configDir: process.env.OPENCODE_CONFIG_DIR,",
          "}))",
          "process.exit(19)",
          "",
        ].join("\n"),
      )
      await fs.chmod(target, 0o755)

      const home = path.join(dir, "home")
      const result = spawnSync(process.execPath, [path.join(import.meta.dir, "../../bin/codefire-agent"), "alpha", "beta"], {
        encoding: "utf8",
        env: { ...process.env, CODEFIRE_AGENT_HOME: home, OPENCODE_BIN_PATH: target },
      })

      expect(result.status).toBe(19)
      expect(JSON.parse(result.stdout.trim())).toEqual({
        codefireAgent: "1",
        argv: ["alpha", "beta"],
        xdgData: path.join(home, "data"),
        configDir: path.join(home, "config", "opencode"),
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("publish helpers expose the public codefire-agent package alias", () => {
    const manifest = generatedPublicPackage({
      name: "opencode",
      version: "1.2.3",
      license: "MIT",
      binaries: { "opencode-darwin-arm64": "1.2.3" },
    })
    expect(manifest.name).toBe("opencode-ai")
    expect(manifest.bin).toEqual({
      opencode: "./bin/opencode.exe",
      "codefire-agent": "./bin/codefire-agent",
    })
    expect(manifest.optionalDependencies).toEqual({ "opencode-darwin-arm64": "1.2.3" })
  })

  test("publish helper returns a valid codefire-agent wrapper", async () => {
    const wrapper = generatedCodeFireAgentWrapper()
    expect(wrapper).toContain('process.env.CODEFIRE_AGENT = "1"')
    expect(wrapper).toContain("applyCodeFireIsolation()")
    expect(wrapper).toContain("OPENCODE_CONFIG_DIR")
    expect(wrapper).toContain('path.join(__dirname, "opencode.exe")')

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codefire-agent-publish-"))
    try {
      const file = path.join(dir, "codefire-agent.cjs")
      await fs.writeFile(file, wrapper)

      const result = spawnSync("node", ["--check", file], { encoding: "utf8" })
      expect(result.status).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("postinstall-skipped placeholder has a POSIX shebang", () => {
    const placeholder = generatedPostinstallSkippedPlaceholder("opencode")
    expect(placeholder.startsWith("#!/bin/sh\n")).toBe(true)
    expect(placeholder).toContain("postinstall script was not run")
    expect(placeholder).toContain("exit 1")
  })

  test("generated codefire-agent wrapper propagates env, args, and exit code", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codefire-agent-generated-"))
    try {
      const bin = path.join(dir, "bin")
      const wrapper = path.join(bin, "codefire-agent")
      const target = path.join(bin, "opencode.exe")
      const output = path.join(dir, "output.json")

      await fs.mkdir(bin)
      await fs.writeFile(wrapper, generatedCodeFireAgentWrapper())
      await fs.writeFile(
        target,
        [
          "#!/usr/bin/env node",
          'const fs = require("fs")',
          `fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
          "  codefireAgent: process.env.CODEFIRE_AGENT,",
          "  argv: process.argv.slice(2),",
          "  xdgData: process.env.XDG_DATA_HOME,",
          "  configDir: process.env.OPENCODE_CONFIG_DIR,",
          "}))",
          "process.exit(17)",
          "",
        ].join("\n"),
      )
      await fs.chmod(wrapper, 0o755)
      await fs.chmod(target, 0o755)

      const result =
        process.platform === "win32"
          ? spawnSync(process.execPath, [wrapper, "alpha", "--flag", "value"], {
              encoding: "utf8",
              env: { ...process.env, CODEFIRE_AGENT_HOME: path.join(dir, "home") },
            })
          : spawnSync(wrapper, ["alpha", "--flag", "value"], {
              encoding: "utf8",
              env: { ...process.env, CODEFIRE_AGENT_HOME: path.join(dir, "home") },
            })

      expect(result.status).toBe(17)
      expect(JSON.parse(await Bun.file(output).text())).toEqual({
        codefireAgent: "1",
        argv: ["alpha", "--flag", "value"],
        xdgData: path.join(dir, "home", "data"),
        configDir: path.join(dir, "home", "config", "opencode"),
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
