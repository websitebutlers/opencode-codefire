/**
 * CodeFireRecall — automatic context recall at session start.
 *
 * On the first user message of a session in a CodeFire-tracked project,
 * fetches relevant wiki pages, context-search hits, and in-progress tasks
 * from the desktop bridge and formats them into a `<codefire-context>`
 * block that gets attached to the message as a synthetic part.
 */
import { Context, Effect, Layer } from "effect"
import { serviceUse } from "@/effect/service-use"
import { CodeFireBridge } from "./bridge"

export const RECALL_DEFAULT_BUDGET = 8000
export const RECALL_DEFAULT_TIMEOUT = 1500

const PREAMBLE =
  "Auto-recalled CodeFire project memory relevant to this request. " +
  "Background context only — verify against current code before relying on it."

type Sections = {
  wiki?: string
  search?: string
  tasks?: string
  budget: number
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

/**
 * Compose recalled sections into one budget-capped `<codefire-context>`
 * block. Returns `undefined` when there is nothing to inject.
 */
export function formatRecallBlock(input: Sections): string | undefined {
  const sections = [
    { header: "## Wiki", body: input.wiki?.trim() },
    { header: "## Code search", body: input.search?.trim() },
    { header: "## In-progress tasks", body: input.tasks?.trim() },
  ].filter((section): section is { header: string; body: string } => Boolean(section.body))
  if (sections.length === 0) return undefined

  const frame = ["<codefire-context>", PREAMBLE, "</codefire-context>"].join("\n").length
  const headers = sections.reduce((sum, section) => sum + section.header.length + 2, 0)
  const available = Math.max(0, input.budget - frame - headers)
  const perSection = Math.floor(available / sections.length)

  const body = sections.map((section) => `${section.header}\n${truncate(section.body, perSection)}`).join("\n\n")

  return ["<codefire-context>", PREAMBLE, "", body, "</codefire-context>"].join("\n").slice(0, input.budget)
}

export interface Interface {
  /**
   * Fetch and format recalled context for the given first-message text.
   * Resolves to `undefined` when the bridge is degraded or nothing relevant
   * was found. Never fails.
   */
  readonly fetch: (text: string, options: { budget: number }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeFireRecall") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bridge = yield* CodeFireBridge.Service

    const fetch = Effect.fn("CodeFireRecall.fetch")(function* (text: string, options: { budget: number }) {
      const capabilities = yield* bridge.capabilities()
      if (!capabilities.recall && !capabilities.tasks) return undefined
      const { wiki, search, tasks } = yield* Effect.all(
        {
          wiki: bridge.suggestWikiPages(text),
          search: bridge.contextSearch(text),
          tasks: bridge.listTasks("in_progress"),
        },
        { concurrency: "unbounded" },
      )
      return formatRecallBlock({ wiki, search, tasks, budget: options.budget })
    })

    return Service.of({ fetch })
  }),
)

export const CodeFireRecall = {
  Service,
  use,
  layer,
  formatRecallBlock,
  RECALL_DEFAULT_BUDGET,
  RECALL_DEFAULT_TIMEOUT,
}
