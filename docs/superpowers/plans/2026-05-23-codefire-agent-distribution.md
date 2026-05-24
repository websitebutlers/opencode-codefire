# CodeFire Agent Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CodeFire Terminal Agent installable for beta users through the most functional path first, while preserving official `opencode` installs and giving CodeFire Desktop a stable programmatic integration surface.

**Architecture:** Use npm as the first public distribution lane because the repo already generates `@codefireapp/agent` and scoped platform optional dependencies. Treat GitHub Releases as the artifact ledger and checksum source, then add Homebrew/native package managers only after release scripts stop referencing upstream OpenCode registries, taps, and package names. Keep Desktop integration through the control API and SDK client rather than shelling out to internal implementation details.

**Tech Stack:** Bun workspace, npm packages with optional platform binaries, GitHub Releases, CodeFire Agent wrapper, CodeFire HTTP control API, `@opencode-ai/sdk/codefire`, CodeFire Desktop.

---

## Distribution Decision

Primary beta distribution should be npm:

```sh
npm install -g @codefireapp/agent@beta
codefire-agent --help
```

Reasons:

- `packages/opencode/script/publish-package.ts` already emits a public package named `@codefireapp/agent`.
- The public package exposes only the `codefire-agent` bin, so it does not overwrite official `opencode`.
- Platform binaries are optional dependencies under `@codefireapp/agent-*`.
- The wrapper isolates runtime state under `CODEFIRE_AGENT_HOME` or `~/.codefire-agent`.
- npm gives a practical beta channel with `dist-tag` promotion to `latest`.

Do not make Homebrew, AUR, Docker, or OS-native installers the first beta lane. `packages/opencode/script/publish.ts` still contains upstream `anomalyco/opencode`, `opencode-bin`, `opencode.rb`, and `ghcr.io/anomalyco/opencode` assumptions. Those need their own CodeFire-owned release plumbing before they are safe distribution channels.

## File Structure

- `docs/codefire-terminal-agent-go-live.md`: Keep as the operator checklist for each release candidate and beta promotion.
- `docs/superpowers/plans/2026-05-23-codefire-agent-distribution.md`: This implementation plan.
- `packages/opencode/package.json`: Owns package-local scripts and source bin mappings.
- `packages/opencode/script/publish-package.ts`: Owns generated public `@codefireapp/agent` package metadata, wrapper, and scoped binary package names.
- `packages/opencode/script/postinstall.mjs`: Owns platform binary resolution and fallback installation.
- `packages/opencode/script/publish.ts`: Owns npm publish flow and currently includes non-npm release channels that must be split before native distribution.
- `packages/opencode/test/codefire/bin.test.ts`: Owns package, wrapper, and install-isolation tests.
- `packages/opencode/test/codefire/control-api.test.ts`: Owns programmatic control API contract tests.
- `packages/opencode/test/codefire/client.test.ts`: Owns SDK client contract tests.
- `packages/sdk/js/package.json`: Exposes `./codefire` SDK client path for Desktop integration.
- `.github/workflows/codefire-agent-release.yml`: Create once release automation is ready.
- `README.md` or `packages/opencode/README.md`: Add public install, beta, rollback, and conflict-safety documentation.

---

### Task 1: Lock The npm Package Contract

**Files:**
- Modify: `packages/opencode/test/codefire/bin.test.ts`
- Modify: `packages/opencode/script/publish-package.ts`
- Verify: `packages/opencode/package.json`

- [ ] **Step 1: Add a failing test for public package metadata**

Add this test to `packages/opencode/test/codefire/bin.test.ts`:

```ts
test("generated public package is safe to publish as the npm beta package", () => {
  const manifest = generatedPublicPackage({
    name: "opencode",
    version: "1.2.3-beta.1",
    license: "MIT",
    binaries: {
      "@codefireapp/agent-darwin-arm64": "1.2.3-beta.1",
      "@codefireapp/agent-linux-x64": "1.2.3-beta.1",
    },
  })

  expect(manifest.name).toBe("@codefireapp/agent")
  expect(manifest.bin).toEqual({ "codefire-agent": "./bin/codefire-agent" })
  expect(manifest.description).toBe("CodeFire Terminal Agent")
  expect(manifest.keywords).toEqual(expect.arrayContaining(["codefire", "terminal", "coding-agent"]))
  expect(manifest.optionalDependencies).toEqual({
    "@codefireapp/agent-darwin-arm64": "1.2.3-beta.1",
    "@codefireapp/agent-linux-x64": "1.2.3-beta.1",
  })
  expect(JSON.stringify(manifest)).not.toContain('"opencode":')
})
```

- [ ] **Step 2: Run the test to verify the current contract**

Run:

```sh
cd packages/opencode
bun test ./test/codefire/bin.test.ts
```

Expected: PASS if the existing implementation already satisfies the contract. If it fails, the failure should identify the exact metadata field to fix.

- [ ] **Step 3: Fix package metadata only if the test fails**

If needed, update `generatedPublicPackage()` in `packages/opencode/script/publish-package.ts` so it returns:

```ts
{
  name: CodeFirePublicPackageName,
  description: "CodeFire Terminal Agent",
  keywords: ["codefire", "agent", "terminal", "coding-agent"],
  bin: {
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
```

- [ ] **Step 4: Run focused verification**

Run:

```sh
cd packages/opencode
bun test ./test/codefire/bin.test.ts
bun run typecheck
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```sh
git add packages/opencode/test/codefire/bin.test.ts packages/opencode/script/publish-package.ts
git commit -m "test: lock codefire npm package contract"
```

---

### Task 2: Split npm Publishing From Native Channels

**Files:**
- Create: `packages/opencode/script/publish-npm.ts`
- Modify: `packages/opencode/script/publish.ts`
- Modify: `packages/opencode/package.json`
- Test: `packages/opencode/test/codefire/bin.test.ts`

- [ ] **Step 1: Write a failing test for npm-only publish script intent**

Add this test to `packages/opencode/test/codefire/bin.test.ts`:

```ts
test("npm beta publish script stays CodeFire-scoped and excludes upstream native channels", async () => {
  const script = await Bun.file(path.join(import.meta.dir, "../../script/publish-npm.ts")).text()

  expect(script).toContain("@codefireapp/agent")
  expect(script).toContain("npm publish")
  expect(script).not.toContain("ghcr.io/anomalyco/opencode")
  expect(script).not.toContain("aur.archlinux.org/opencode-bin")
  expect(script).not.toContain("homebrew-tap")
})
```

- [ ] **Step 2: Run the test to verify it fails because the file does not exist**

Run:

```sh
cd packages/opencode
bun test ./test/codefire/bin.test.ts
```

Expected: FAIL with a missing `publish-npm.ts` file.

- [ ] **Step 3: Create the npm-only publish script**

Create `packages/opencode/script/publish-npm.ts` by extracting the npm package generation and npm publish logic from `publish.ts`. Keep only:

```ts
#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"
import {
  CodeFirePublicPackageName,
  generatedCodeFireBinaryPackageName,
  generatedCodeFireAgentWrapper,
  generatedPostinstallSkippedPlaceholder,
  generatedPublicPackage,
} from "./publish-package"

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

async function main() {
  const dir = fileURLToPath(new URL("..", import.meta.url))
  process.chdir(dir)

  const binaries: Record<string, string> = {}
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
    const binaryPackagePath = `./dist/${filepath}`
    const binaryPackage = await Bun.file(binaryPackagePath).json()
    const codefireName = generatedCodeFireBinaryPackageName(binaryPackage.name)
    await Bun.file(binaryPackagePath).write(JSON.stringify({ ...binaryPackage, name: codefireName }, null, 2))
    binaries[codefireName] = binaryPackage.version
  }

  const version = Object.values(binaries)[0]
  if (!version) throw new Error("No platform binary packages found in packages/opencode/dist")

  await $`mkdir -p ./dist/${pkg.name}`
  await $`mkdir -p ./dist/${pkg.name}/bin`
  await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
  await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
  await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
    generatedPostinstallSkippedPlaceholder(CodeFirePublicPackageName),
  )
  await Bun.file(`./dist/${pkg.name}/bin/codefire-agent`).write(generatedCodeFireAgentWrapper())
  await Bun.file(`./dist/${pkg.name}/package.json`).write(
    JSON.stringify(generatedPublicPackage({ name: pkg.name, version, license: pkg.license, binaries }), null, 2),
  )

  await Promise.all(
    Object.entries(binaries).map(async ([name]) => {
      const platformDir = name.replace(`${CodeFirePublicPackageName}-`, "")
      await publish(`./dist/${pkg.name}-${platformDir}`, name, binaries[name])
    }),
  )
  await publish(`./dist/${pkg.name}`, CodeFirePublicPackageName, version)
}

if (import.meta.main) await main()
```

- [ ] **Step 4: Add explicit package scripts**

In `packages/opencode/package.json`, add:

```json
"release:npm": "bun run script/publish-npm.ts",
"release:all": "bun run script/publish.ts"
```

- [ ] **Step 5: Run focused verification**

Run:

```sh
cd packages/opencode
bun test ./test/codefire/bin.test.ts
bun run typecheck
```

Expected: test and typecheck pass.

- [ ] **Step 6: Commit**

```sh
git add packages/opencode/script/publish-npm.ts packages/opencode/script/publish.ts packages/opencode/package.json packages/opencode/test/codefire/bin.test.ts
git commit -m "feat: add codefire npm-only publish lane"
```

---

### Task 3: Add Local Pack And Install Smoke Script

**Files:**
- Create: `packages/opencode/script/smoke-install-codefire-agent.ts`
- Modify: `packages/opencode/package.json`
- Test: `packages/opencode/test/codefire/bin.test.ts`

- [ ] **Step 1: Write a failing test for the smoke script**

Add this test to `packages/opencode/test/codefire/bin.test.ts`:

```ts
test("install smoke script checks codefire-agent without invoking opencode bin", async () => {
  const script = await Bun.file(path.join(import.meta.dir, "../../script/smoke-install-codefire-agent.ts")).text()

  expect(script).toContain("codefire-agent")
  expect(script).toContain("--help")
  expect(script).toContain("command -v opencode")
  expect(script).toContain("command -v codefire-agent")
  expect(script).not.toContain("opencode --help")
})
```

- [ ] **Step 2: Run the test to verify it fails because the file does not exist**

Run:

```sh
cd packages/opencode
bun test ./test/codefire/bin.test.ts
```

Expected: FAIL with missing smoke script.

- [ ] **Step 3: Create the smoke script**

Create `packages/opencode/script/smoke-install-codefire-agent.ts`:

```ts
#!/usr/bin/env bun
import { $ } from "bun"
import { mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

const prefix = await mkdtemp(join(tmpdir(), "codefire-agent-smoke-"))

try {
  await $`npm install -g @codefireapp/agent@beta --prefix ${prefix}`
  await $`${prefix}/bin/codefire-agent --help`
  await $`${prefix}/bin/codefire-agent --version`
  await $`command -v opencode`.nothrow()
  await $`command -v codefire-agent`.nothrow()
  console.log(`Smoke prefix: ${prefix}`)
} finally {
  if (!process.env.KEEP_CODEFIRE_AGENT_SMOKE_PREFIX) {
    await rm(prefix, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: Add the package script**

In `packages/opencode/package.json`, add:

```json
"smoke:install": "bun run script/smoke-install-codefire-agent.ts"
```

- [ ] **Step 5: Run focused verification without network install**

Run:

```sh
cd packages/opencode
bun test ./test/codefire/bin.test.ts
bun run typecheck
```

Expected: tests and typecheck pass. Do not run `bun run smoke:install` until a beta has been published.

- [ ] **Step 6: Commit**

```sh
git add packages/opencode/script/smoke-install-codefire-agent.ts packages/opencode/package.json packages/opencode/test/codefire/bin.test.ts
git commit -m "feat: add codefire install smoke script"
```

---

### Task 4: Document User Install, Desktop Install, And Rollback

**Files:**
- Modify: `docs/codefire-terminal-agent-go-live.md`
- Modify: `README.md` or `packages/opencode/README.md`

- [ ] **Step 1: Add public install documentation**

Add this section to the selected public README:

```md
## Install CodeFire Terminal Agent

Beta:

```sh
npm install -g @codefireapp/agent@beta
codefire-agent --help
```

Stable, after promotion:

```sh
npm install -g @codefireapp/agent
codefire-agent --help
```

The package installs a `codefire-agent` executable only. It is designed to coexist with official `opencode` installs and stores CodeFire agent state under `~/.codefire-agent` by default. Set `CODEFIRE_AGENT_HOME` to use a different state directory.

Rollback:

```sh
npm uninstall -g @codefireapp/agent
rm -rf ~/.codefire-agent
```
```

- [ ] **Step 2: Add Desktop install notes**

Add:

```md
## CodeFire Desktop Integration

CodeFire Desktop should discover and manage the agent through the CodeFire control API and SDK client instead of depending on OpenCode internals.

- Start command: `codefire-agent serve --hostname 127.0.0.1 --port 0`
- Identity: `CODEFIRE_AGENT=1`
- Agent Chat mode: `CODEFIRE_AGENT_CHAT=1`
- Lifecycle file: `CODEFIRE_AGENT_LIFECYCLE_FILE=/path/to/events.jsonl`
- SDK import: `@opencode-ai/sdk/codefire`
- Required endpoints: `/codefire/v1/manifest`, `/health`, `/models`, `/settings`, `/connections`, `/mcp`, `/lifecycle`
```

- [ ] **Step 3: Update the go-live checklist with release scripts**

In `docs/codefire-terminal-agent-go-live.md`, replace the publish command with:

```sh
OPENCODE_CHANNEL=beta bun run release:npm
```

Keep native channels listed as blocked until CodeFire-owned Homebrew, Docker, AUR, and GitHub Release plumbing is implemented.

- [ ] **Step 4: Verify docs**

Run:

```sh
rg "npm install -g @codefireapp/agent|release:npm|CODEFIRE_AGENT_HOME|@opencode-ai/sdk/codefire" docs README.md packages/opencode/README.md
```

Expected: each term appears in the intended documentation.

- [ ] **Step 5: Commit**

```sh
git add docs/codefire-terminal-agent-go-live.md README.md packages/opencode/README.md
git commit -m "docs: add codefire agent install and rollback guide"
```

---

### Task 5: Add Release Automation Gate

**Files:**
- Create: `.github/workflows/codefire-agent-release.yml`
- Modify: `docs/codefire-terminal-agent-go-live.md`

- [ ] **Step 1: Create a manual beta release workflow**

Create `.github/workflows/codefire-agent-release.yml`:

```yaml
name: CodeFire Agent Release

on:
  workflow_dispatch:
    inputs:
      channel:
        description: npm dist-tag to publish
        required: true
        default: beta
        type: choice
        options:
          - beta
          - latest

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun test ./test/codefire/control-api.test.ts ./test/codefire/client.test.ts ./test/codefire/bin.test.ts ./test/codefire/identity.test.ts ./test/codefire/lifecycle.test.ts ./test/codefire/mcp.test.ts ./test/codefire/codefire.test.ts ./test/codefire/prompt-integration.test.ts ./test/codefire/logo.test.ts
        working-directory: packages/opencode
      - run: bun run typecheck
        working-directory: packages/opencode
      - run: bun run typecheck
        working-directory: packages/sdk/js

  publish-npm:
    needs: verify
    runs-on: ubuntu-latest
    environment: npm-release
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run build
        working-directory: packages/opencode
      - run: OPENCODE_CHANNEL=${{ inputs.channel }} bun run release:npm
        working-directory: packages/opencode
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 2: Update go-live doc with workflow requirements**

Add:

```md
## Release Automation Requirements

- GitHub environment: `npm-release`
- Secret: `NPM_TOKEN` with publish rights for `@codefire`
- Manual workflow: `CodeFire Agent Release`
- First beta must be run with `channel=beta`
- `latest` promotion requires a successful Desktop integration smoke against the beta package
```

- [ ] **Step 3: Verify workflow syntax by inspection and focused tests**

Run:

```sh
rg "CodeFire Agent Release|release:npm|NPM_TOKEN|npm-release" .github docs/codefire-terminal-agent-go-live.md
cd packages/opencode
bun test ./test/codefire/bin.test.ts
```

Expected: workflow and docs contain the required release terms; tests pass.

- [ ] **Step 4: Commit**

```sh
git add .github/workflows/codefire-agent-release.yml docs/codefire-terminal-agent-go-live.md
git commit -m "ci: add manual codefire npm release workflow"
```

---

### Task 6: Run Beta Publish And Promotion Checklist

**Files:**
- Modify: `docs/codefire-terminal-agent-go-live.md`
- No code changes expected after the release branch is verified.

- [ ] **Step 1: Verify local release candidate**

Run:

```sh
cd packages/opencode
bun test ./test/codefire/control-api.test.ts ./test/codefire/client.test.ts ./test/codefire/bin.test.ts ./test/codefire/identity.test.ts ./test/codefire/lifecycle.test.ts ./test/codefire/mcp.test.ts ./test/codefire/codefire.test.ts ./test/codefire/prompt-integration.test.ts ./test/codefire/logo.test.ts
bun run typecheck
cd ../sdk/js
bun run typecheck
cd ../../..
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Publish beta**

Run through the manual GitHub workflow with:

```text
channel=beta
```

Expected: `@codefireapp/agent@beta` and matching `@codefireapp/agent-*` platform packages are visible in npm.

- [ ] **Step 3: Smoke install beta on macOS arm64**

Run:

```sh
npm install -g @codefireapp/agent@beta --prefix /tmp/codefire-agent-beta
/tmp/codefire-agent-beta/bin/codefire-agent --help
/tmp/codefire-agent-beta/bin/codefire-agent --version
command -v opencode
command -v codefire-agent
```

Expected: `codefire-agent --help` shows CodeFire identity and the standalone CodeFire logo. `opencode` and `codefire-agent` resolve to different paths.

- [ ] **Step 4: Smoke Desktop programmatic integration**

Run the agent locally:

```sh
CODEFIRE_AGENT=1 codefire-agent serve --hostname 127.0.0.1 --port 0
```

From CodeFire Desktop, verify it can call the SDK client path and read:

```ts
import { CodeFireAgentClient } from "@opencode-ai/sdk/codefire"

const client = new CodeFireAgentClient({ baseUrl: "http://127.0.0.1:<port>" })
const snapshot = await client.snapshot()
console.log(snapshot.manifest.schemaVersion)
```

Expected: `schemaVersion` is `1`, and Desktop can display models, settings, connections, MCP state, and lifecycle support without custom fetch wrappers.

- [ ] **Step 5: Promote only after two-platform smoke**

Run beta smoke on at least:

```text
macOS arm64
Linux x64
```

Then promote through GitHub workflow:

```text
channel=latest
```

- [ ] **Step 6: Record release evidence**

Update `docs/codefire-terminal-agent-go-live.md` with:

```md
## Release Evidence

- npm beta version:
- npm latest version:
- GitHub workflow run:
- macOS arm64 smoke:
- Linux x64 smoke:
- Desktop integration smoke:
- Rollback tested:
```

- [ ] **Step 7: Commit release evidence**

```sh
git add docs/codefire-terminal-agent-go-live.md
git commit -m "docs: record codefire agent release evidence"
```

---

## Self-Review

- Spec coverage: npm distribution, conflict avoidance with official `opencode`, Desktop programmatic integration, release verification, rollback, and later native-channel gating are covered.
- Placeholder scan: no `TBD`, generic "add tests", or undefined implementation steps remain.
- Type consistency: package names use `@codefireapp/agent` and `@codefireapp/agent-*`; binary name is consistently `codefire-agent`; Desktop SDK import is `@opencode-ai/sdk/codefire` to match the current package export.
