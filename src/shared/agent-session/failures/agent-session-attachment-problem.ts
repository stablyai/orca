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
  /** 1-based index among attachments in this message. */
  index?: number
  /** File name of the attachment that failed. */
  name?: string
  /** Actual size of the attachment in bytes. */
  size?: number
}

const REASONS: Record<string, AgentSessionAttachmentProblemReason> = {
  tooMany: 'tooMany',
  totalTooLarge: 'totalTooLarge',
  tooLarge: 'tooLarge',
  empty: 'empty',
  unsupportedType: 'unsupportedType',
  notAFile: 'notAFile',
  noSource: 'noSource'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readAttachmentProblemReason(
  reason: unknown
): AgentSessionAttachmentProblemReason | undefined {
  return typeof reason === 'string' ? REASONS[reason] : undefined
}

export function readAttachmentProblem(value: unknown): AgentSessionAttachmentProblem | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const reason = readAttachmentProblemReason(value.reason)
  if (!reason) {
    return undefined
  }
  const limit =
    typeof value.limit === 'number' && Number.isFinite(value.limit) && value.limit > 0
      ? value.limit
      : undefined
  const index =
    typeof value.index === 'number' && Number.isInteger(value.index) && value.index > 0
      ? value.index
      : undefined
  const name =
    typeof value.name === 'string' && value.name.trim().length > 0 ? value.name.trim() : undefined
  const size =
    typeof value.size === 'number' && Number.isFinite(value.size) && value.size > 0
      ? value.size
      : undefined
  return {
    reason,
    ...(limit !== undefined ? { limit } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(size !== undefined ? { size } : {})
  }
}
