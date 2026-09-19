/** `at` is a wall-clock ms epoch; `when-idle` waits for the agent to stop, so the
 *  text cannot interleave with a turn still in progress. */
export type ScheduledMessageTiming = { kind: 'at'; sendAt: number } | { kind: 'when-idle' }

/** Failures persist rather than disappear: the user authored the text and is
 *  entitled to know it never arrived. */
export type ScheduledMessageStatus = 'pending' | 'missed' | 'failed'

export type ScheduledMessageFailureReason =
  /** The due moment arrived with no live terminal in the workspace. */
  | 'no-pane'
  /** A terminal existed but no recognized agent was running in it. */
  | 'no-agent'
  /** The agent was there and the send itself was rejected or errored. */
  | 'send-failed'
  /** Orca was closed past the late-delivery grace window. */
  | 'expired-while-closed'
  /** The usage limit outlasted the maximum wait — unlike `expired-while-closed`,
   *  Orca was running the whole time and holding the message back. */
  | 'usage-limit-outlasted'

/** Stored flat in PersistedState, not on WorktreeMeta: meta travels as one opaque
 *  array through a read-modify-write RPC, which loses a write when two owners edit. */
export type ScheduledMessage = {
  /** Stable id so edit/delete can address one entry without index drift. */
  id: string
  worktreeId: string
  text: string
  timing: ScheduledMessageTiming
  createdAt: number
  status: ScheduledMessageStatus
  /** Set only alongside a 'missed'/'failed' status. */
  failureReason?: ScheduledMessageFailureReason
}

/** What the user supplies to create a message; main assigns the rest. Shared so the
 *  dialog, preload bridge, IPC handler and service cannot drift apart. */
export type ScheduledMessageDraft = {
  worktreeId: string
  text: string
  timing: ScheduledMessageTiming
}

/** Both fields optional: a future `timing` alone is the reschedule path for a
 *  missed/failed row. */
export type ScheduledMessageChanges = {
  text?: string
  timing?: ScheduledMessageTiming
}

/** Telegram caps a chat at 100 pending messages; the same ceiling keeps a
 *  runaway script from turning the persisted state file into a spool. */
export const MAX_SCHEDULED_MESSAGES_PER_WORKSPACE = 100

/** Telegram allows scheduling up to a year out. Past this the wall-clock timer
 *  is more likely to be a typo than an intent. */
export const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

/** How late a due message may still be delivered silently; past it the agent's
 *  context has moved on. */
export const SCHEDULED_MESSAGE_MISSED_GRACE_MS = 10 * 60 * 1000

/** Ceiling on waiting out a usage limit: covers a 5-hour window plus an overnight
 *  sleep, so a weekly limit deliberately outlasts it. */
export const SCHEDULED_MESSAGE_MAX_USAGE_LIMIT_WAIT_MS = 12 * 60 * 60 * 1000

/** A coarse scan, not one timer per message: the one-year horizon is far past
 *  setTimeout's ~24.8-day ceiling, where a delay overflows to firing immediately. */
export const SCHEDULED_MESSAGE_TICK_MS = 30 * 1000

/** Full-list push: a dropped event cannot desynchronize the tab. */
export type ScheduledMessagesSnapshot = {
  messages: ScheduledMessage[]
}

export const SCHEDULED_MESSAGES_UPDATE_CHANNEL = 'scheduledMessages:update'

/** Id alone is not enough: `update` replaces a row under the same id, and `status`
 *  legitimately flips back to pending. */
export function isSameScheduledDelivery(a: ScheduledMessage, b: ScheduledMessage): boolean {
  return a.id === b.id && a.text === b.text && timingKey(a.timing) === timingKey(b.timing)
}

function timingKey(timing: ScheduledMessageTiming): string {
  return timing.kind === 'at' ? `at:${timing.sendAt}` : timing.kind
}

/** Derived, not stored: the status and the reason can never contradict each other. */
export function scheduledMessageStatusForFailure(
  failureReason: ScheduledMessageFailureReason
): Exclude<ScheduledMessageStatus, 'pending'> {
  return failureReason === 'expired-while-closed' || failureReason === 'usage-limit-outlasted'
    ? 'missed'
    : 'failed'
}
