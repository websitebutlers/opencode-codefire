# Multi-Agent Orchestration

CodeFire Terminal Agent runs subagents in parallel in the background, isolates them in git worktrees, and fans out batches of agents in a single tool call.

## Background subagents

Background subagents are **on by default** (no experimental flag required). The model launches one with `task(background: true)` and keeps working; when the subagent finishes, its result is injected back into the parent session and the parent resumes automatically (event-driven, no polling).

- Poll or block on a background task with `task_status(task_id, wait: true|false)`.
- Resume a finished subagent session by passing its `task_id` back to `task`.
- Kill switches: `OPENCODE_DISABLE_BACKGROUND_SUBAGENTS=1` (env, also hides the `task_status`/`agents` tools and the `background` parameter) or `orchestration.background: false` (config, rejects at call time).

## Concurrency cap

```jsonc
{
  "orchestration": {
    "max_parallel": 4 // default
  }
}
```

All background subagents — from `task` and from `agents` fan-outs — share one per-instance slot pool. Excess tasks still report `running` but their work queues until a slot frees up.

## Worktree isolation

`task(isolation: "worktree")` runs the subagent in a freshly provisioned git worktree (branch `opencode/<name>`), fully populated before the agent starts:

- The child session, its prompt loop, and its tools all operate inside the worktree directory.
- If the agent **changed nothing** (clean `git status`, HEAD unmoved), the worktree and branch are removed automatically.
- If the agent **made changes** (dirty tree or new commits), the worktree is kept; the branch name, path, and a diffstat are appended to the tool result and recorded in the tool metadata (`worktree: { directory, branch }`), so the work can be reviewed and merged.
- `isolation` cannot be combined with `task_id` (a resumed session already has a directory).
- Errors leave the worktree in place so partial work isn't lost.

Requires a git project. Composes with `background: true`.

## Fan-out: the `agents` tool

One call spawns N subagents concurrently as a single job group:

```
agents(tasks: [
  { description: "audit auth",  prompt: "...", subagent_type: "explore" },
  { description: "fix flaky test", prompt: "...", isolation: "worktree" },
  { description: "update docs", prompt: "..." },
])
```

- `wait: true` (default): the call blocks until every task settles and returns aggregated per-task results (`## description / task_id / state / output`). Completions are **not** injected into the parent (the tool collects them), and interrupting the call cancels the group.
- `wait: false`: returns the `group_id` and per-task `task_id`s immediately; poll with `task_status`. Completions surface through the normal background inject path.
- Every task shares the `orchestration.max_parallel` slot pool.

## Events & observability

- `background.job.updated` (Bus): published on every job transition (`running` → `completed` / `error` / `cancelled`) with the full job info including `groupID`. Job state lives in `BackgroundJob` (`list({ groupID? })`, `get`, `wait`, `cancel`).
- `session.next.subagent.completed` (v2 event stream): emitted when a v2 `subagent()` child finishes, carrying `parentID`, `agent`, and the subagent's final text.
- Session busy/idle/retry status streams over SSE `/event` as before; `SessionStatus.waitIdle(sessionID)` is the event-driven way to wait for a session to go idle.

## Config reference

```jsonc
{
  "orchestration": {
    "background": true, // set false to disable background subagents
    "max_parallel": 4 // concurrent background subagent slots
  }
}
```
