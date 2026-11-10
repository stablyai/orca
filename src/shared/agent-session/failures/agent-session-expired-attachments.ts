// The uploads a refused message referenced that the host no longer stores.

import {
  isNativeChatPastedImagePath,
  isNativeChatPastedTextPath
} from '../../native-chat/native-chat-image-label'

/** Bounds the refusal, whose details a receipt or ledger row may keep; removing these and sending again names any others. */
export const AGENT_SESSION_EXPIRED_ATTACHMENTS_MAX = 32

export type AgentSessionExpiredAttachment = {
  uploadId: string
  /** The stored file name its chip is labelled with, or the id when the message gave no name. */
  name: string
}

function isExpiredAttachment(value: unknown): value is AgentSessionExpiredAttachment {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uploadId' in value &&
    typeof value.uploadId === 'string' &&
    value.uploadId.length > 0 &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0
  )
}

export function readAgentSessionExpiredAttachments(
  value: unknown
): AgentSessionExpiredAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const kept = value
    .filter(isExpiredAttachment)
    .slice(0, AGENT_SESSION_EXPIRED_ATTACHMENTS_MAX)
    .map(({ uploadId, name }) => ({ uploadId, name }))
  return kept.length > 0 ? kept : undefined
}

/** Names a person would recognize: a paste's generated name means nothing to them, so only its marked chip says which. */
export function agentSessionExpiredAttachmentNames(
  expired: readonly AgentSessionExpiredAttachment[]
): string[] {
  const recognizable = expired
    .map(({ name }) => name)
    .filter((name) => !isNativeChatPastedImagePath(name) && !isNativeChatPastedTextPath(name))
  return [...new Set(recognizable)]
}
