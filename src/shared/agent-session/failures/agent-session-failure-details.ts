// Readers for fact details that stand alone, apart from the fact's own shape.

import { isValidAppVersion } from '../../app-version'

/** Which of Orca's checks an image failed. A new one needs a sentence before it compiles. */
export const AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS = [
  'empty',
  'tooLarge',
  'tooMany',
  'totalTooLarge',
  'unsupportedType',
  'notAFile',
  'noSource'
] as const
export type AgentSessionAttachmentProblemReason =
  (typeof AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS)[number]

export type AgentSessionAttachmentProblem = {
  reason: AgentSessionAttachmentProblemReason
  /** The limit it broke: bytes for `tooLarge` and `totalTooLarge`, a count for `tooMany`. */
  limit?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readAttachmentProblem(value: unknown): AgentSessionAttachmentProblem | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const reason = AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS.find((known) => known === value.reason)
  if (!reason) {
    return undefined
  }
  const limit = value.limit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? { reason, limit }
    : { reason }
}

const AGENT_UPDATE_MAX_LENGTH = 64

/** A release the agent must reach: a bounded version, never free text. */
export function readAgentUpdate(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= AGENT_UPDATE_MAX_LENGTH && isValidAppVersion(value)
  )
}
