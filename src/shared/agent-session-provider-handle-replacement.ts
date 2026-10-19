/**
 * What a chain link records when the provider could not restore a chat's saved conversation and a
 * fresh one took over.
 */

import type { AgentSessionProviderHandle } from './agent-session-provider-handle'
import {
  isAgentSessionProviderHandleKeyFor,
  isAgentSessionProviderHandleReadByOlderBuilds
} from './agent-session-provider-handle-encoding'

const MAX_REPLACEMENT_REASON_LENGTH = 64

/**
 * Why a chat's agent no longer remembers what came before this link: the provider could not
 * restore the conversation the chat had, so a fresh one continues it without that history.
 */
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
    // Why: older builds read Claude and Codex rows and refuse a creation anywhere but first in a
    // chain, so a replacement there would set the whole chat aside after a downgrade. Every other
    // agent's row is one they never read. A Claude or Codex fallback must first pick a stored shape.
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
