import {
  MAX_SCHEDULE_HORIZON_MS,
  type ScheduledMessage,
  type ScheduledMessageFailureReason,
  type ScheduledMessageStatus,
  type ScheduledMessageTiming
} from './scheduled-message-types'

// orca-data.json is hand-editable, and this is the one array main later types
// into a live agent.

const STATUSES: readonly ScheduledMessageStatus[] = ['pending', 'missed', 'failed']

const FAILURE_REASONS: readonly ScheduledMessageFailureReason[] = [
  'no-pane',
  'no-agent',
  'send-failed',
  'expired-while-closed',
  'usage-limit-outlasted'
]

function isStatus(value: unknown): value is ScheduledMessageStatus {
  return STATUSES.some((status) => status === value)
}

function isFailureReason(value: unknown): value is ScheduledMessageFailureReason {
  return FAILURE_REASONS.some((reason) => reason === value)
}

function normalizeTiming(value: unknown): ScheduledMessageTiming | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return null
  }
  if (value.kind === 'when-idle') {
    return { kind: 'when-idle' }
  }
  if (
    value.kind === 'at' &&
    'sendAt' in value &&
    typeof value.sendAt === 'number' &&
    Number.isFinite(value.sendAt)
  ) {
    return { kind: 'at', sendAt: value.sendAt }
  }
  return null
}

export function normalizeScheduledMessage(value: unknown): ScheduledMessage | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('worktreeId' in value) ||
    !('text' in value) ||
    !('timing' in value) ||
    !('createdAt' in value)
  ) {
    return null
  }
  const timing = normalizeTiming(value.timing)
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.worktreeId !== 'string' ||
    value.worktreeId.length === 0 ||
    typeof value.text !== 'string' ||
    timing === null ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt)
  ) {
    return null
  }
  // Absent status predates the field; an unrecognized one is a delivery state we cannot guess.
  const rawStatus = 'status' in value ? value.status : undefined
  if (rawStatus !== undefined && !isStatus(rawStatus)) {
    return null
  }
  const status = rawStatus ?? 'pending'
  const rawFailureReason = 'failureReason' in value ? value.failureReason : undefined
  const failureReason = isFailureReason(rawFailureReason) ? rawFailureReason : undefined
  return {
    id: value.id,
    worktreeId: value.worktreeId,
    text: value.text,
    timing,
    createdAt: value.createdAt,
    status,
    ...(status === 'pending' || failureReason === undefined ? {} : { failureReason })
  }
}

/** Drops malformed rows and duplicate ids rather than failing the whole load —
 *  one corrupt entry must not cost the user the rest of their queue. */
export function normalizeScheduledMessages(value: unknown): ScheduledMessage[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const messages: ScheduledMessage[] = []
  for (const entry of value) {
    const message = normalizeScheduledMessage(entry)
    if (message && !seen.has(message.id)) {
      seen.add(message.id)
      messages.push(message)
    }
  }
  return messages
}

export type ScheduledMessageValidationError =
  | 'empty-text'
  | 'send-at-in-past'
  | 'send-at-beyond-horizon'

export function validateScheduledMessageText(text: string): ScheduledMessageValidationError | null {
  return text.trim().length === 0 ? 'empty-text' : null
}

/** Split out so an edit that leaves the timing alone is not judged on it: a row
 *  whose moment has passed is exactly the one reopened to fix the wording. */
export function validateScheduledMessageTiming(
  timing: ScheduledMessageTiming,
  now: number
): ScheduledMessageValidationError | null {
  if (timing.kind !== 'at') {
    return null
  }
  if (timing.sendAt <= now) {
    return 'send-at-in-past'
  }
  return timing.sendAt - now > MAX_SCHEDULE_HORIZON_MS ? 'send-at-beyond-horizon' : null
}

/** Shared by the compose dialog (to disable Save) and the main-process CRUD (to
 *  reject), so the two can never disagree about what is schedulable. */
export function validateScheduledMessageDraft(
  draft: { text: string; timing: ScheduledMessageTiming },
  now: number
): ScheduledMessageValidationError | null {
  return (
    validateScheduledMessageText(draft.text) ?? validateScheduledMessageTiming(draft.timing, now)
  )
}
