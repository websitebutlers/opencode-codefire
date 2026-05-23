export function generatedCodeFireAgentWrapper() {
  return [
    "#!/usr/bin/env node",
    "",
    'const childProcess = require("child_process")',
    'const path = require("path")',
    "",
    'const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"]',
    'const target = path.join(__dirname, "opencode.exe")',
    'process.env.CODEFIRE_AGENT = "1"',
    "",
    "const child = childProcess.spawn(target, process.argv.slice(2), {",
    '  stdio: "inherit",',
    "  env: process.env,",
    "})",
    "",
    'child.on("error", (error) => {',
    "  console.error(error.message)",
    "  process.exit(1)",
    "})",
    "",
    "const forwarders = {}",
    "for (const signal of forwardedSignals) {",
    "  forwarders[signal] = () => {",
    "    try {",
    "      child.kill(signal)",
    "    } catch {",
    "      // The child may have already exited.",
    "    }",
    "  }",
    "  process.on(signal, forwarders[signal])",
    "}",
    "",
    'child.on("exit", (code, signal) => {',
    "  for (const forwardedSignal of forwardedSignals) {",
    "    process.removeListener(forwardedSignal, forwarders[forwardedSignal])",
    "  }",
    "",
    "  if (signal) {",
    "    process.kill(process.pid, signal)",
    "    return",
    "  }",
    "",
    '  process.exit(typeof code === "number" ? code : 0)',
    "})",
    "",
  ].join("\n")
}

export function generatedPostinstallSkippedPlaceholder(name: string) {
  return [
    "#!/bin/sh",
    `echo "Error: ${name}-ai's postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${name}-ai && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${name}-ai without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n")
}

export function generatedPublicPackage(input: {
  name: string
  version: string
  license: string
  binaries: Record<string, string>
}) {
  return {
    name: input.name + "-ai",
    bin: {
      [input.name]: `./bin/${input.name}.exe`,
      "codefire-agent": "./bin/codefire-agent",
    },
    scripts: {
      postinstall: "node ./postinstall.mjs",
    },
    version: input.version,
    license: input.license,
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    optionalDependencies: input.binaries,
  }
}
