/**
 * Built-in plugin that runs the declarative shell hooks from the config
 * `hooks` block (see src/hooks/exec.ts for the execution contract).
 *
 * Blocking: pre_tool hooks run sequentially before every matching tool
 * call; a non-zero exit throws, which surfaces to the model as a tool
 * error (the same path permission denials take) and the loop continues.
 * Everything else (post_tool, file_edited, session lifecycle) observes:
 * fire-and-forget with self-caught errors, because a throw from an
 * observing hook would kill the surrounding tool call.
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import type { Config } from "@/config/config"
import {
  blockMessage,
  execHook,
  extractEditedFiles,
  matchesGlob,
  matchesTool,
  LIFECYCLE_TIMEOUT,
  PRE_TOOL_TIMEOUT,
} from "./exec"

const log = Log.create({ service: "hooks" })

type HookEntry = NonNullable<NonNullable<Config.Info["hooks"]>["pre_tool"]>[number]

const AWARENESS =
  "Some tool calls may be blocked by user-configured pre_tool hooks. A blocked call is user policy, not a transient error — adjust your approach instead of retrying the same call."

export const HooksPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  let cfg: Config.Info["hooks"] = undefined
  // session.status bookkeeping so session_idle only fires on a real
  // busy→idle transition (mirrors the TUI notifications feature-plugin)
  const active = new Set<string>()

  const env = (extra: Record<string, string>) => ({
    OPENCODE_WORKTREE: input.worktree,
    ...extra,
  })

  /** Fire-and-forget an observing hook; never throws. */
  const observe = (entry: HookEntry, hook: string, extraEnv: Record<string, string>, payload: unknown) => {
    void execHook({
      command: entry.command,
      cwd: input.worktree,
      env: env({ OPENCODE_HOOK: hook, ...extraEnv }),
      payload,
      timeout: entry.timeout ?? LIFECYCLE_TIMEOUT,
    })
      .then((result) => {
        if ("failed" in result) log.warn(`${hook} hook failed`, { command: entry.command, error: result.failed })
        else if (result.code !== 0)
          log.warn(`${hook} hook exited non-zero`, { command: entry.command, code: result.code })
      })
      .catch((error) => log.warn(`${hook} hook crashed`, { command: entry.command, error: String(error) }))
  }

  const lifecycle = (hook: "session_start" | "session_idle" | "session_error", sessionID: string, payload: unknown) => {
    for (const entry of cfg?.[hook] ?? []) {
      observe(entry, hook, { OPENCODE_HOOK_SESSION: sessionID }, payload)
    }
  }

  return {
    config: async (config) => {
      cfg = (config as Config.Info).hooks
    },

    "tool.execute.before": async ({ tool, sessionID, callID }, { args }) => {
      for (const entry of cfg?.pre_tool ?? []) {
        if (!matchesTool(entry.tools, tool)) continue
        const result = await execHook({
          command: entry.command,
          cwd: input.worktree,
          env: env({ OPENCODE_HOOK: "pre_tool", OPENCODE_HOOK_TOOL: tool, OPENCODE_HOOK_SESSION: sessionID }),
          payload: { hook: "pre_tool", tool, sessionID, callID, args },
          timeout: entry.timeout ?? PRE_TOOL_TIMEOUT,
        })
        if ("failed" in result) {
          // fail open: a typo'd hook must not brick every tool call
          log.warn("pre_tool hook failed, allowing call", { command: entry.command, error: result.failed })
          continue
        }
        if (result.code !== 0) throw new Error(blockMessage(entry.command, result.code, result.stderr))
      }
    },

    "tool.execute.after": async ({ tool, sessionID, callID, args }, output) => {
      for (const entry of cfg?.post_tool ?? []) {
        if (!matchesTool(entry.tools, tool)) continue
        observe(
          entry,
          "post_tool",
          { OPENCODE_HOOK_TOOL: tool, OPENCODE_HOOK_SESSION: sessionID },
          { hook: "post_tool", tool, sessionID, callID, args, title: output.title },
        )
      }
      const edited = cfg?.file_edited?.length ? extractEditedFiles(tool, args, output) : []
      for (const file of edited) {
        for (const entry of cfg?.file_edited ?? []) {
          if (!matchesGlob(entry.glob, file, input.worktree)) continue
          observe(
            entry,
            "file_edited",
            { OPENCODE_HOOK_TOOL: tool, OPENCODE_HOOK_SESSION: sessionID, OPENCODE_HOOK_FILE: file },
            { hook: "file_edited", file, tool, sessionID },
          )
        }
      }
    },

    event: async ({ event }) => {
      const type = (event as { type?: string }).type
      const properties = (event as { properties?: any }).properties
      if (!type || !properties) return

      if (type === "session.created") {
        if (properties.info?.parentID) return // subagents share the worktree
        lifecycle("session_start", properties.info?.id ?? "", {
          hook: "session_start",
          sessionID: properties.info?.id,
          event: properties,
        })
        return
      }

      if (type === "session.status") {
        const sessionID: string = properties.sessionID
        const status = properties.status?.type
        if (status === "idle") {
          if (!active.delete(sessionID)) return // only fire on busy→idle
          lifecycle("session_idle", sessionID, { hook: "session_idle", sessionID, event: properties })
        } else if (status) {
          active.add(sessionID)
        }
        return
      }

      if (type === "session.error") {
        lifecycle("session_error", properties.sessionID ?? "", {
          hook: "session_error",
          sessionID: properties.sessionID,
          event: properties,
        })
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (!cfg?.pre_tool?.length) return
      output.system.push(AWARENESS)
    },
  }
}
