# CodeFire Terminal Agent Go-Live Checklist

Last verified: 2026-05-23

## Release Target

- Public npm package: `@codefireapp/agent`
- Public executable: `codefire-agent`
- Platform packages: `@codefireapp/agent-darwin-arm64`, `@codefireapp/agent-darwin-x64`, `@codefireapp/agent-linux-*`, `@codefireapp/agent-windows-*`
- State isolation: default `CODEFIRE_AGENT_HOME=$HOME/.codefire-agent`
- Upstream engine attribution: OpenCode remains the internal execution engine and upstream base.

## Local Verification Evidence

Run from `packages/opencode` unless noted.

| Check | Command | Result |
| --- | --- | --- |
| CodeFire focused tests | `bun test ./test/codefire/control-api.test.ts ./test/codefire/client.test.ts ./test/codefire/bin.test.ts ./test/codefire/identity.test.ts ./test/codefire/lifecycle.test.ts ./test/codefire/mcp.test.ts ./test/codefire/codefire.test.ts ./test/codefire/prompt-integration.test.ts ./test/codefire/logo.test.ts` | Pass: 47 tests |
| OpenCode package typecheck | `bun run typecheck` | Pass |
| SDK package typecheck | `cd ../sdk/js && bun run typecheck` | Pass |
| CodeFire help/identity smoke | `CODEFIRE_AGENT=1 bun run --conditions=browser ./src/index.ts --help` | Pass: CodeFire logo, `codefire-agent`, CodeFire command descriptions |
| Control API smoke | `bun --conditions=browser -e '<manifest/health/lifecycle smoke>'` | Pass: `/manifest`, `/health`, `/lifecycle` returned 200 |
| npm pack smoke | `bun test ./test/codefire/bin.test.ts` | Pass: generated `@codefireapp/agent` packs and exposes only `codefire-agent` |
| Install conflict check | `command -v opencode && command -v codefire-agent && test "$(command -v opencode)" != "$(command -v codefire-agent)"` | Pass: official `opencode` and local `codefire-agent` resolve to different paths |
| Whitespace check | `git diff --check` | Pass |

## Beta Publish Plan

1. Commit the current CodeFire productization changes on `dev`.
2. Push `dev` to the fork remote.
3. Build release artifacts from `packages/opencode`:

   ```sh
   bun run build
   ```

4. Inspect generated package manifests before publishing:

   ```sh
   find packages/opencode/dist -name package.json -maxdepth 3 -print
   ```

   Confirm the public package is `@codefireapp/agent`, platform packages are under `@codefireapp/agent-*`, and the public `bin` contains only `codefire-agent`.

5. Publish beta with the existing publish script using the beta channel/tag:

   ```sh
   OPENCODE_CHANNEL=beta bun run script/publish.ts
   ```

6. Install and smoke test in a clean temp prefix:

   ```sh
   npm install -g @codefireapp/agent@beta --prefix /tmp/codefire-agent-beta
   /tmp/codefire-agent-beta/bin/codefire-agent --help
   /tmp/codefire-agent-beta/bin/codefire-agent --version
   ```

7. Verify no official OpenCode conflict:

   ```sh
   command -v opencode
   command -v codefire-agent
   ```

8. Create a GitHub prerelease for the same commit/tag with:

   - install command: `npm install -g @codefireapp/agent@beta`
   - rollback command: `npm uninstall -g @codefireapp/agent`
   - known scope: CodeFire wrapper, control API, SDK client, MCP bootstrap, lifecycle JSONL

## Promotion Criteria

- `@codefireapp/agent@beta` installs on macOS arm64 and starts without shadowing `opencode`.
- `codefire-agent --help` shows CodeFire identity and the terminal-agent logo.
- `/codefire/v1/manifest`, `/health`, `/models`, `/settings`, `/connections`, `/mcp`, and `/lifecycle` return schemaVersion `1`.
- Desktop can import `@opencode-ai/sdk/codefire` and call `snapshot()` against a running agent.
- Lifecycle events can be observed through `CODEFIRE_AGENT_LIFECYCLE_FILE`.
- CodeFire MCP diagnostics report project context and a clear missing/configured state.

## Rollback

- npm beta rollback: deprecate or unpublish only if npm policy allows and no users depend on the broken tarball.
- User rollback: `npm uninstall -g @codefireapp/agent`, then remove `~/.codefire-agent` if local agent state should be discarded.
- Repo rollback: revert the release commit on `dev`, rebuild, and publish a newer beta with the fix.
- Official OpenCode is isolated by package/bin/state and should not need rollback action.

## Manual Gates Before Latest

- Run the beta install smoke on macOS x64, Linux x64, Linux arm64, and Windows x64.
- Confirm CodeFire Desktop consumes the control API client without hand-rolled fetch calls.
- Confirm Agent Chat lifecycle JSONL events are ingested by Desktop.
- Confirm CodeFire MCP is auto-configured in the target Desktop environment.
- Promote `@codefireapp/agent@beta` to `latest` only after at least one full Desktop integration pass.
