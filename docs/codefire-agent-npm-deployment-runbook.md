# CodeFire Agent npm Deployment Runbook

Last updated: 2026-05-23

## Goal

Publish the CodeFire Terminal Agent beta npm package as `@codefireapp/agent@0.1.0-beta.1`, resume safely from the partial publish state caused by npm 2FA, smoke test the install, and leave the package ready for later promotion to `latest`.

## Current Known State

- Target package: `@codefireapp/agent`
- Target executable: `codefire-agent`
- Target version: `0.1.0-beta.1`
- Target npm tag: `beta`
- Some platform packages may already be published from the interrupted run.
- The prior publish failed with `EOTP` because npm required a publish-time second factor.
- A token was pasted into chat and must be considered compromised.

## Do Not Skip

1. Revoke the exposed npm token before publishing again.
2. Create a fresh npm token with 2FA bypass enabled for publish.
3. Do not paste the new token into chat, docs, git, shell history screenshots, or task notes.
4. Publish beta first. Do not publish or promote `latest` until beta smoke tests pass.

## Token Setup

Create a fresh token in npm:

- Token name: `codefire-agent-publish`
- Description: `Publish @codefireapp/agent beta and platform packages`
- Bypass two-factor authentication: enabled
- Allowed IP ranges: blank for local publishing
- Package/scope permissions: read/write for `@codefire`
- Organization permissions: no admin access unless npm requires org access for the scope

Set the token locally:

```sh
export NPM_TOKEN="npm_your_new_token"
npm config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"
npm whoami --registry=https://registry.npmjs.org/
```

Expected: `npm whoami` prints the npm username that owns or can publish to `@codefire`.

## Preflight Checks

Run from the repo package:

```sh
cd /Users/nicknorris/Documents/claude-code-projects/codefire-terminal/packages/opencode
npm access list packages @codefire --registry=https://registry.npmjs.org/
```

Check which version artifacts already exist:

```sh
for pkg in \
  @codefireapp/agent \
  @codefireapp/agent-darwin-arm64 \
  @codefireapp/agent-darwin-x64 \
  @codefireapp/agent-darwin-x64-baseline \
  @codefireapp/agent-linux-arm64 \
  @codefireapp/agent-linux-x64 \
  @codefireapp/agent-linux-x64-baseline \
  @codefireapp/agent-linux-arm64-musl \
  @codefireapp/agent-linux-x64-musl \
  @codefireapp/agent-linux-x64-baseline-musl \
  @codefireapp/agent-windows-arm64 \
  @codefireapp/agent-windows-x64 \
  @codefireapp/agent-windows-x64-baseline
do
  npm view "$pkg@0.1.0-beta.1" version --registry=https://registry.npmjs.org/ || echo "MISSING: $pkg"
done
```

Expected: already-published packages print `0.1.0-beta.1`; missing packages print `MISSING: ...`.

## Local Verification Before Publishing

Run:

```sh
cd /Users/nicknorris/Documents/claude-code-projects/codefire-terminal/packages/opencode
bun test ./test/codefire/control-api.test.ts ./test/codefire/client.test.ts ./test/codefire/bin.test.ts ./test/codefire/identity.test.ts ./test/codefire/lifecycle.test.ts ./test/codefire/mcp.test.ts ./test/codefire/codefire.test.ts ./test/codefire/prompt-integration.test.ts ./test/codefire/logo.test.ts
bun run typecheck
cd ../sdk/js
bun run typecheck
cd ../../..
git diff --check
```

Expected: all commands exit 0.

## Build Artifacts

Use a fixed version for both build and publish:

```sh
cd /Users/nicknorris/Documents/claude-code-projects/codefire-terminal/packages/opencode
OPENCODE_CHANNEL=beta OPENCODE_VERSION=0.1.0-beta.1 bun run build
```

Expected:

- `packages/opencode/dist` is rebuilt.
- The current-platform binary smoke in the build script passes.
- Build artifacts use version `0.1.0-beta.1`.

## Publish Beta

Resume publish with the same fixed version:

```sh
cd /Users/nicknorris/Documents/claude-code-projects/codefire-terminal/packages/opencode
OPENCODE_CHANNEL=beta OPENCODE_VERSION=0.1.0-beta.1 bun run script/publish.ts
```

Expected:

- Packages already published are skipped with `already published ...`.
- Missing `@codefireapp/agent-*` platform packages publish with tag `beta`.
- The public `@codefireapp/agent` package publishes with tag `beta`.
- Because `OPENCODE_CHANNEL=beta` is preview mode, the script skips the upstream Docker/Homebrew/AUR release block.

If npm returns `EOTP`, the active token is not bypassing 2FA for publish. Revoke it and create a new automation/granular access token with 2FA bypass enabled.

## Verify Published Package

Run:

```sh
npm view @codefireapp/agent@beta version --registry=https://registry.npmjs.org/
npm view @codefireapp/agent@0.1.0-beta.1 bin optionalDependencies --json --registry=https://registry.npmjs.org/
```

Expected:

- `@codefireapp/agent@beta` resolves to `0.1.0-beta.1`.
- `bin` contains only `codefire-agent`.
- `optionalDependencies` contains `@codefireapp/agent-*` packages.

## Smoke Install

Install into a temporary prefix:

```sh
tmp="$(mktemp -d)"
npm install -g @codefireapp/agent@beta --prefix "$tmp" --registry=https://registry.npmjs.org/
"$tmp/bin/codefire-agent" --help
"$tmp/bin/codefire-agent" --version
```

Expected:

- Help output starts with the CodeFire terminal-agent logo.
- Commands use `codefire-agent`.
- Version prints `0.1.0-beta.1`.

Check official OpenCode isolation:

```sh
command -v opencode || true
command -v codefire-agent || true
test "$(command -v opencode || true)" != "$(command -v codefire-agent || true)"
```

Expected: if both commands exist, they resolve to different paths.

## Optional Control API Smoke

Start a local beta agent server:

```sh
CODEFIRE_AGENT=1 "$tmp/bin/codefire-agent" serve --hostname 127.0.0.1 --port 0
```

In another terminal, use the printed server port:

```sh
curl -sS "http://127.0.0.1:PORT/codefire/v1/manifest"
curl -sS "http://127.0.0.1:PORT/codefire/v1/health"
```

Expected:

- Both endpoints return JSON.
- `schemaVersion` is `1`.
- Manifest identifies CodeFire agent mode.

## Promotion To Latest

Promote only after beta install and Desktop integration checks pass:

```sh
npm dist-tag add @codefireapp/agent@0.1.0-beta.1 latest --registry=https://registry.npmjs.org/
npm view @codefireapp/agent dist-tags --json --registry=https://registry.npmjs.org/
```

Expected: `latest` points to `0.1.0-beta.1`.

## Rollback

If beta is bad but already published:

```sh
npm dist-tag rm @codefireapp/agent beta --registry=https://registry.npmjs.org/
```

If `latest` was promoted by mistake:

```sh
npm dist-tag add @codefireapp/agent@PREVIOUS_GOOD_VERSION latest --registry=https://registry.npmjs.org/
```

If users installed the bad beta:

```sh
npm uninstall -g @codefireapp/agent
rm -rf ~/.codefire-agent
```

Prefer publishing a fixed newer beta over unpublishing packages. npm unpublish rules are time- and dependency-sensitive.

## Evidence To Capture

After deployment, update `docs/codefire-terminal-agent-go-live.md` with:

```md
## Release Evidence

- npm beta version:
- npm package URL:
- Published platform packages:
- Smoke install machine:
- `codefire-agent --help` result:
- `codefire-agent --version` result:
- OpenCode conflict check:
- Control API smoke:
- Desktop integration smoke:
- Rollback decision:
```
