/** Record a fresh conversation taking over when the provider cannot restore the saved one. */

import type { AgentSessionProviderHandle } from './agent-session-provider-handle'
import {
  isAgentSessionProviderHandleKeyFor,
  isAgentSessionProviderHandleReadByOlderBuilds
} from './agent-session-provider-handle-encoding'

const MAX_REPLACEMENT_REASON_LENGTH = 64

/** A fresh conversation continues without the history the provider could not restore. */
export type AgentSessionProviderHandleReplacement = {
  /** Key of the conversation that was lost: the head this creation followed. */
  key: string
  /** Open: a later build may record a reason this one does not name, and it must stay readable. */
  reason: 'restore-failed' | (string & {})
  /** When the replacement was made; a link's `observedAt` moves with its resume point. */
  replacedAt: number
}

export function isAgentSessionProviderHandleReplacement(
  handle: AgentSessionProviderHandle,
  value: unknown
): value is AgentSessionProviderHandleReplacement {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('key' in value) ||
    !('reason' in value) ||
    !('replacedAt' in value)
  ) {
    return false
  }
  const { key, reason, replacedAt } = value
  return (
    // Older builds reject later Claude/Codex creations, setting the whole chat aside on downgrade. Other agents were unreadable there; typed-lane fallback needs a stored-shape decision first.
    !isAgentSessionProviderHandleReadByOlderBuilds(handle) &&
    isAgentSessionProviderHandleKeyFor(handle, key) &&
    typeof reason === 'string' &&
    reason.length > 0 &&
    reason.length <= MAX_REPLACEMENT_REASON_LENGTH &&
    typeof replacedAt === 'number' &&
    Number.isSafeInteger(replacedAt) &&
    replacedAt >= 0
  )
}

export function agentSessionProviderHandleReplacementsEqual(
  left: AgentSessionProviderHandleReplacement | undefined,
  right: AgentSessionProviderHandleReplacement | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.key === right.key &&
      left.reason === right.reason &&
      left.replacedAt === right.replacedAt)
  )
}
