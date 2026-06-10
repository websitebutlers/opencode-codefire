import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { Session as CoreSession } from "@opencode-ai/core/session"
import { withStatics } from "@opencode-ai/core/schema"

export const SessionID = CoreSession.ID
export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("part", id)),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>

export const CheckpointID = Schema.String.check(Schema.isStartsWith("chk")).pipe(
  Schema.brand("CheckpointID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("checkpoint", id)),
  })),
)

export type CheckpointID = Schema.Schema.Type<typeof CheckpointID>
