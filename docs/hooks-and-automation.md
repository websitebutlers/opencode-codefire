# Hooks & Automation

CodeFire Terminal Agent supports declarative automation in `opencode.json`: shell hooks that react to (and can block) agent activity, recurring schedules, and attention notifications.

## Shell hooks

```jsonc
{
  "hooks": {
    "pre_tool": [
      { "tools": ["bash"], "command": "./scripts/guard.sh", "timeout": 10000 }
    ],
    "post_tool": [{ "tools": ["edit", "write"], "command": "echo edited >> /tmp/log" }],
    "file_edited": [{ "glob": "*.ts", "command": "bunx prettier --write \"$OPENCODE_HOOK_FILE\"" }],
    "session_start": [{ "command": "echo session started" }],
    "session_idle": [
      { "command": "osascript -e 'display notification \"Agent finished\" with title \"CodeFire\"'" }
    ],
    "session_error": [{ "command": "notify-send 'CodeFire' 'Session errored'" }]
  }
}
```

### Execution contract

- Commands are shell strings run via the system shell with the **worktree as cwd**.
- Environment variables: `OPENCODE_HOOK` (event name), `OPENCODE_HOOK_TOOL`, `OPENCODE_HOOK_SESSION`, `OPENCODE_HOOK_FILE` (file_edited only), `OPENCODE_WORKTREE`.
- The full event payload is piped to **stdin as JSON**, e.g. for `pre_tool`:
  `{"hook":"pre_tool","tool":"bash","sessionID":"ses_…","callID":"…","args":{…}}`.
- Default timeout: 10s for `pre_tool`, 30s for everything else; override per entry with `timeout` (ms).

### Blocking semantics (`pre_tool` only)

- `pre_tool` hooks run **sequentially in config order before** every matching tool call.
- **Any non-zero exit blocks the tool call.** The hook's stderr (trimmed to 2000 chars) is shown to the model as the tool error, so write a clear reason: `echo "use the deploy script instead of raw kubectl" >&2; exit 1`.
- Spawn failures and timeouts **fail open** (the call is allowed, a warning is logged) so a broken hook cannot brick the agent.
- All other hook types are observe-only: they never block, and failures are logged.

### Filters

- `tools`: array of tool-name patterns with `*`/`?` wildcards (`"bash"`, `"mcp_*"`). Omit to match all tools.
- `glob` (file_edited): matched against the worktree-relative path, the basename, and the absolute path (`"*.ts"`, `"src/*.ts"`).

## Schedules

```jsonc
{
  "schedules": [
    { "name": "standup", "at": "09:00", "prompt": "Summarize in-progress work and open TODOs", "agent": "plan" },
    { "name": "deps", "every": "1d", "prompt": "Check for outdated dependencies and report", "model": "anthropic/claude-sonnet-4-6" }
  ]
}
```

- `every`: interval like `"90s"`, `"30m"`, `"4h"`, `"1d"` (minimum 60s). `at`: daily local time `"HH:MM"`. One of the two is required.
- Each run creates a **fresh session** titled `Schedule: <name> — <timestamp>` — the session list is the run history.
- Schedules are **in-process**: they run while the agent (TUI or `serve`) is alive. No catch-up for missed runs after restarts. Two long-lived processes on the same project will both run them.
- Overlap protection: a new run is skipped while the previous run of the same schedule is still going.
- The first interval run happens after one full interval (no run at startup).
- Disable one entry with `"enabled": false`, or everything with `OPENCODE_DISABLE_SCHEDULES=1`.

## Notifications

Terminal attention (sounds + terminal notification escapes) is configured in `tui.json` under `attention` and is **enabled by default**:

```jsonc
{
  "attention": {
    "enabled": true,
    "notifications": true, // terminal notification escape when blurred (terminal-dependent)
    "sound": true,
    "volume": 0.4
  }
}
```

OS-level delivery of the notification escape depends on your terminal (Ghostty, Kitty, WezTerm, iTerm2 support it). For guaranteed native notifications on any terminal, use a lifecycle hook:

```jsonc
{
  "hooks": {
    "session_idle": [
      { "command": "osascript -e 'display notification \"Done\" with title \"CodeFire\"'" }
    ]
  }
}
```
