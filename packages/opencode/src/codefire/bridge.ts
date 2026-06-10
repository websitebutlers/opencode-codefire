/**
 * CodeFireBridge — typed access to the CodeFire Desktop app's memory
 * (context engine, wiki, tasks, notes) over the auto-registered "codefire"
 * MCP server, for use by built-in agent code (recall, capture).
 *
 * All helpers degrade gracefully: when the bridge is missing, disconnected,
 * or only the bundled minimal server is available, calls resolve to
 * `undefined`/`false` instead of failing.
 */
import { Context, Effect, Layer } from "effect"
import { serviceUse } from "@/effect/service-use"
import { MCP } from "@/mcp"
import { CodeFireMCP } from "./mcp"

export type Capabilities = {
  /** context_search + wiki suggestion tools are available */
  recall: boolean
  /** create_note is available */
  capture: boolean
  /** list_tasks is available */
  tasks: boolean
}

export const NO_CAPABILITIES: Capabilities = { recall: false, capture: false, tasks: false }

/**
 * Derive bridge capabilities from the MCP server's tool definitions.
 * The bundled minimal server only exposes `codefire_info`, so every
 * capability maps to the presence of the specific tool it needs.
 */
export function detectCapabilities(defs: readonly { name: string }[] | undefined): Capabilities {
  if (!defs) return NO_CAPABILITIES
  const names = new Set(defs.map((def) => def.name))
  return {
    recall: names.has("context_search"),
    capture: names.has("create_note"),
    tasks: names.has("list_tasks"),
  }
}

type ToolResultLike = {
  isError?: boolean
  content?: unknown
}

/**
 * Join the text content parts of an MCP tool result into one string.
 * Returns `undefined` for error results, missing content, or all-empty text.
 */
export function parseToolResultText(result: ToolResultLike | undefined): string | undefined {
  if (!result || result.isError) return undefined
  if (!Array.isArray(result.content)) return undefined
  const text = result.content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      )
    })
    .map((part) => part.text)
    .filter((line) => line.length > 0)
    .join("\n")
  return text.length > 0 ? text : undefined
}

export interface Interface {
  readonly capabilities: () => Effect.Effect<Capabilities>
  readonly call: (
    tool: string,
    args?: Record<string, unknown>,
    options?: { timeout?: number },
  ) => Effect.Effect<string | undefined>
  readonly contextSearch: (query: string) => Effect.Effect<string | undefined>
  readonly suggestWikiPages: (text: string) => Effect.Effect<string | undefined>
  readonly listTasks: (status?: string) => Effect.Effect<string | undefined>
  readonly createNote: (input: { title: string; content: string }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeFireBridge") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const server = CodeFireMCP.mcpName()

    const capabilities = Effect.fn("CodeFireBridge.capabilities")(function* () {
      return detectCapabilities(yield* mcp.toolDefs(server))
    })

    const call = Effect.fn("CodeFireBridge.call")(function* (
      tool: string,
      args?: Record<string, unknown>,
      options?: { timeout?: number },
    ) {
      const result = yield* mcp.callTool(server, tool, args, options)
      return parseToolResultText(result as ToolResultLike | undefined)
    })

    const gated = (capability: keyof Capabilities, tool: string, args?: Record<string, unknown>) =>
      Effect.gen(function* () {
        const caps = yield* capabilities()
        if (!caps[capability]) return undefined
        return yield* call(tool, args)
      })

    return Service.of({
      capabilities,
      call,
      contextSearch: (query) => gated("recall", "context_search", { query }),
      suggestWikiPages: (text) => gated("recall", "suggest_wiki_pages", { query: text }),
      listTasks: (status) => gated("tasks", "list_tasks", status ? { status } : undefined),
      createNote: (input) =>
        gated("capture", "create_note", { title: input.title, content: input.content }).pipe(
          Effect.map((text) => text !== undefined),
        ),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(MCP.defaultLayer))

export const CodeFireBridge = {
  Service,
  use,
  layer,
  defaultLayer,
  detectCapabilities,
  parseToolResultText,
  NO_CAPABILITIES,
}
