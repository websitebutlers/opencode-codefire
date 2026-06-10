import * as Tool from "./tool"
import DESCRIPTION from "./agents.txt"
import { BackgroundJob } from "@/background/job"
import { Identifier } from "@/id/id"
import { TaskTool } from "./task"
import { Cause, Effect, Exit, Schema } from "effect"

const id = "agents"

export const Parameters = Schema.Struct({
  tasks: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
        prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
        subagent_type: Schema.optional(Schema.String).annotate({
          description: "The type of specialized agent to use for this task (default: general)",
        }),
        isolation: Schema.optional(Schema.Literals(["worktree"])).annotate({
          description: "Set to 'worktree' to run this agent in an isolated git worktree",
        }),
      }),
    ),
  ).annotate({ description: "Tasks to run concurrently" }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true (default) wait for every task and return aggregated results; when false return task ids immediately for task_status polling",
  }),
})

type TaskResult = {
  description: string
  task_id: string
  state: "completed" | "error" | "cancelled" | "running" | "failed_to_start"
  text: string
}

function section(result: TaskResult) {
  return [
    `## ${result.description}`,
    `task_id: ${result.task_id || "(none)"}`,
    `state: ${result.state}`,
    "",
    result.text,
  ].join("\n")
}

export const AgentsTool = Tool.define(
  id,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const taskInfo = yield* TaskTool
    const taskDef = yield* taskInfo.init()

    const run = Effect.fn("AgentsTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.tasks.length === 0) {
        return yield* Effect.fail(new Error("tasks must not be empty"))
      }
      const wait = params.wait !== false
      const groupID = Identifier.ascending("group")

      const spawned: TaskResult[] = []
      for (const task of params.tasks) {
        const exit = yield* taskDef
          .execute(
            {
              description: task.description,
              prompt: task.prompt,
              subagent_type: task.subagent_type ?? "general",
              isolation: task.isolation,
              background: true,
            },
            {
              ...ctx,
              extra: {
                ...ctx.extra,
                jobGroupID: groupID,
                // when waiting, this tool aggregates results itself; without
                // waiting, completions surface through the normal inject path
                suppressBackgroundInject: wait,
              },
            },
          )
          .pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          spawned.push({
            description: task.description,
            task_id: "",
            state: "failed_to_start",
            text: String(Cause.squash(exit.cause)),
          })
          continue
        }
        spawned.push({
          description: task.description,
          task_id: exit.value.metadata.sessionId as string,
          state: "running",
          text: "started",
        })
      }

      yield* ctx.metadata({
        title: `${params.tasks.length} agents`,
        metadata: { groupID, tasks: spawned.map((item) => ({ description: item.description, task_id: item.task_id })) },
      })

      if (!wait) {
        return {
          title: `${params.tasks.length} agents started`,
          metadata: { groupID, tasks: spawned },
          output: [
            `group_id: ${groupID}`,
            "All tasks started in the background. Poll individual tasks with task_status.",
            "",
            ...spawned.map(section),
          ].join("\n"),
        }
      }

      const settled = yield* Effect.forEach(
        spawned,
        (item) =>
          Effect.gen(function* () {
            if (item.state === "failed_to_start" || !item.task_id) return item
            const result = yield* background.wait({ id: item.task_id })
            const info = result.info
            if (!info) return { ...item, state: "error" as const, text: "task not found" }
            return {
              ...item,
              state: info.status === "running" ? ("running" as const) : info.status,
              text: info.output ?? info.error ?? "",
            }
          }),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.forEach(spawned, (item) => (item.task_id ? background.cancel(item.task_id) : Effect.void), {
            concurrency: "unbounded",
            discard: true,
          }).pipe(Effect.ignore),
        ),
      )

      const failed = settled.filter((item) => item.state !== "completed").length
      return {
        title: `${settled.length - failed}/${settled.length} agents completed`,
        metadata: { groupID, tasks: settled },
        output: [`group_id: ${groupID}`, "", ...settled.map(section)].join("\n\n"),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
