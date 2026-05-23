import { describe, expect, test } from "bun:test"
import path from "path"

describe("codefire-agent bin alias", () => {
  test("package.json exposes codefire-agent beside opencode", async () => {
    const pkg = await Bun.file(path.join(import.meta.dir, "../../package.json")).json()
    expect(pkg.bin.opencode).toBe("./bin/opencode")
    expect(pkg.bin["codefire-agent"]).toBe("./bin/opencode")
  })

  test("node wrapper preserves codefire-agent invocation", async () => {
    const wrapper = await Bun.file(path.join(import.meta.dir, "../../bin/opencode")).text()
    expect(wrapper).toContain('path.basename(process.argv[1] || "")')
    expect(wrapper).toContain('process.env.CODEFIRE_AGENT = "1"')
  })
})
