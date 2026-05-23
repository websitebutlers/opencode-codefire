# CodeFire Agent Harness Design

## Purpose

Create a CodeFire-specific agent harness from the `websitebutlers/opencode-codefire` fork without turning the fork into a broad rename of OpenCode. The first version should feel native inside CodeFire Agent Chat while remaining usable as a standalone terminal CLI.

## Goals

- Add a `codefire-agent` binary alias that runs the OpenCode runtime with CodeFire defaults.
- Treat CodeFire project context as a first-class orientation source: current project, wiki, tasks, notes, and context search.
- Detect when the process is launched by CodeFire Agent Chat and adapt startup behavior to the thread, project, and handoff context.
- Preserve upstream OpenCode structure where practical so future upstream syncs remain manageable.
- Keep model and provider selection on existing OpenCode configuration paths unless launch integration requires a narrow exception.

## Non-Goals

- Do not rename every OpenCode package, namespace, environment variable, UI string, or config directory in v1.
- Do not replace the OpenCode TUI, server, provider, or session systems.
- Do not hard-code one model provider for CodeFire.
- Do not make CodeFire MCP availability mandatory for standalone terminal usage.

## Recommended Approach

Use a small CodeFire adapter layer inside `packages/opencode`, invoked only when the process is launched as `codefire-agent` or an equivalent CodeFire profile flag is present.

The adapter should own:

- Runtime mode detection: Agent Chat, standalone CodeFire terminal, or normal OpenCode.
- CodeFire environment parsing: project ID, thread ID, handoff metadata, and any CodeFire-specific context passed by the parent app.
- Default instruction generation: concise startup guidance that tells the agent to prefer CodeFire MCP for project context, wiki, tasks, and notes before broad source searches.
- Fallback behavior: if CodeFire MCP metadata is missing, continue as a terminal CLI with CodeFire-oriented defaults rather than failing startup.

The OpenCode core should remain the execution engine. The CodeFire layer should feed it launch-time identity and instructions rather than duplicating session or provider logic.

## Architecture

The initial implementation should touch a narrow set of surfaces:

- `packages/opencode/package.json`
  - Add a `codefire-agent` bin alias that points at the existing executable path. Use a very small CodeFire bootstrap only if implementation proves the existing binary cannot distinguish invocation names cleanly.
- `packages/opencode/src/index.ts` or a nearby bootstrap module
  - Detect `codefire-agent` invocation early enough to apply CodeFire defaults before command parsing and session startup.
- `packages/opencode/src/codefire/`
  - New focused module directory for CodeFire-specific runtime detection, environment parsing, and instruction text.
- `packages/opencode/test/` or the established local test location
  - Add targeted tests for CodeFire mode detection and generated startup instructions.

The adapter boundary should be explicit. CodeFire behavior should not be scattered as ad hoc checks across unrelated CLI, TUI, provider, and session files.

## Agent Chat Behavior

When launched from CodeFire Agent Chat, `codefire-agent` should:

- Recognize CodeFire-provided project and thread metadata.
- Prefer CodeFire MCP tools for orientation:
  - current project lookup
  - in-progress task lookup
  - wiki suggestions and reads
  - context search
  - durable notes or task notes for non-obvious findings
- Include the parent thread and handoff context in startup instructions when provided.
- Keep terminal handoffs disabled in favor of CodeFire Agent Chat handoff requests when that metadata is present.
- Degrade cleanly if a particular CodeFire MCP tool is unavailable.

## Standalone Terminal Behavior

When launched outside Agent Chat, `codefire-agent` should:

- Start normally from a terminal.
- Use the same CodeFire-oriented orientation defaults when CodeFire MCP is configured.
- Avoid requiring Agent Chat-only environment variables.
- Preserve ordinary OpenCode config, provider, and model behavior.

## Error Handling

The CodeFire adapter should treat missing CodeFire metadata as a mode signal, not as a fatal error. Fatal startup errors should be limited to malformed values that would cause incorrect behavior, such as an invalid non-numeric thread ID where Agent Chat mode was explicitly requested.

Instruction generation should be deterministic and easy to test. It should avoid depending on live MCP calls during unit tests.

## Testing

Verification should run from package directories, not the repo root.

Minimum v1 checks:

- `bun typecheck` from `packages/opencode`
- Targeted `bun test` coverage for the new CodeFire module
- A smoke check that `codefire-agent --help` resolves to the expected CLI identity after the bin alias is added

## Open Questions For Implementation

- Which exact environment variables will CodeFire set for Agent Chat launches?
- Should the CodeFire profile be detected only by `process.argv[1]`, or should it also support an explicit environment variable for app launches where argv is normalized?
- Should the v1 startup instruction be injected globally, as an agent default, or through the session startup path?
- Does the package build process automatically include extra bin aliases, or does any release/install script need a parallel update?

## Success Criteria

- `codefire-agent` is available as a CLI entrypoint.
- Running `codefire-agent` starts the normal OpenCode runtime with CodeFire-specific orientation behavior.
- Agent Chat launches can pass project/thread/handoff metadata into the process without custom prompt rewriting in the parent app.
- Standalone terminal launches remain functional without Agent Chat metadata.
- The implementation remains small enough to review and rebase against upstream OpenCode.
