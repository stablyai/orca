import { MAX_PATH_LENGTH } from '../accounts/agent-session-account-home'

export type AgentSessionAuxiliaryChat = {
  /** The visible parent this unlisted child belongs to and derives its provider context from. */
  parentSessionId: string
  /** The provider session file's own id, so close/discard never needs to re-resolve a moved file. */
  nativeSessionId: string
  /** Absolute provider session file created for the child; removed only after its runtime exits. */
  nativeFilePath: string
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const MAX_ID_LENGTH = 512

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

/** Stored auxiliary metadata is bounded and names a real Orca session. */
export function isAgentSessionAuxiliaryChat(value: unknown): value is AgentSessionAuxiliaryChat {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const auxiliary = value as Partial<AgentSessionAuxiliaryChat>
  return (
    typeof auxiliary.parentSessionId === 'string' &&
    SESSION_ID_PATTERN.test(auxiliary.parentSessionId) &&
    isBoundedString(auxiliary.nativeSessionId, MAX_ID_LENGTH) &&
    isBoundedString(auxiliary.nativeFilePath, MAX_PATH_LENGTH)
  )
}
