import { createMemo, createResource, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import { useDialog } from "../../ui/dialog"

export type RewindMode = "both" | "conversation" | "files"

/**
 * Mode picker + preview for rewinding a session to a past message. Fetches
 * the would-be-undone diff up front so the user sees what each choice does
 * before committing.
 */
export function DialogRewind(props: {
  sessionID: string
  messageID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const [preview] = createResource(() =>
    sdk.client.session
      .revertPreview({ sessionID: props.sessionID, messageID: props.messageID })
      .then((result) => result.data)
      .catch(() => undefined),
  )

  const fileStats = createMemo(() => {
    const data = preview()
    if (preview.loading) return "computing changes…"
    if (!data || data.diffs.length === 0) return "no file changes"
    const additions = data.diffs.reduce((sum, diff) => sum + diff.additions, 0)
    const deletions = data.diffs.reduce((sum, diff) => sum + diff.deletions, 0)
    const files = `${data.diffs.length} file${data.diffs.length === 1 ? "" : "s"}`
    return `${files} +${additions} -${deletions}`
  })

  const messageStats = createMemo(() => {
    const data = preview()
    if (preview.loading) return "…"
    const count = data?.messages ?? 0
    return `${count} message${count === 1 ? "" : "s"}`
  })

  const refillPrompt = () => {
    if (!props.setPrompt) return
    const parts = sync.data.part[props.messageID] ?? []
    props.setPrompt(
      parts.reduce(
        (agg, part) => {
          if (part.type === "text") {
            if (!part.synthetic) agg.input += part.text
          }
          if (part.type === "file") agg.parts.push(strip(part))
          return agg
        },
        { input: "", parts: [] as PromptInfo["parts"] },
      ),
    )
  }

  const rewind = (mode: RewindMode) => {
    void sdk.client.session.revert({
      sessionID: props.sessionID,
      messageID: props.messageID,
      mode,
    })
    if (mode !== "files") refillPrompt()
  }

  const options = createMemo((): DialogSelectOption<RewindMode>[] => [
    {
      title: "Rewind conversation + files",
      value: "both",
      description: `undo ${messageStats()} and restore ${fileStats()}`,
      onSelect: (dialog) => {
        rewind("both")
        dialog.clear()
      },
    },
    {
      title: "Conversation only",
      value: "conversation",
      description: `undo ${messageStats()}, keep files as they are`,
      onSelect: (dialog) => {
        rewind("conversation")
        dialog.clear()
      },
    },
    {
      title: "Files only",
      value: "files",
      description: `restore ${fileStats()}, keep all messages`,
      onSelect: (dialog) => {
        rewind("files")
        dialog.clear()
      },
    },
  ])

  return <DialogSelect title="Rewind" options={options()} />
}
