// What a bot automation's compact chat row draws and says outside its run: its mark, and a wait's
// label and status. The desktop and the phone draw the same row from these.
import type { AutomationEventSource } from '../automation-event-triggers'
import type { AutomationOnce, WaitEnding } from '../automation-once'
import type { BotAutomationFacts } from '../bots/bot-automation-rows'
import type { AutomationRunMessage } from './automation-run-message'
import type { AutomationRunWording, SayAutomationRun } from './automation-run-row-words'

/** The connector whose black-and-white logo the row draws, else a plain mark for what starts it. */
export type AutomationRowMark =
  | 'github'
  | 'slack'
  | 'linear'
  | 'google'
  | 'webhook'
  | 'schedule'
  | 'deadline'
  | 'manual'
  /** An event whose connector the row can't tell. */
  | 'event'

const SOURCE_MARKS = {
  github: 'github',
  slack: 'slack',
  linear: 'linear',
  gmail: 'google',
  calendar: 'google',
  webhook: 'webhook'
} as const satisfies Record<AutomationEventSource, AutomationRowMark>

/** A saved automation's mark: the connector of its first event, else a wait's hourglass or a clock. */
export function automationRowMark(
  automation: Pick<BotAutomationFacts, 'on' | 'once'>
): AutomationRowMark {
  const source = automation.on?.[0]?.source
  if (source) {
    return SOURCE_MARKS[source]
  }
  return automation.once ? 'deadline' : 'schedule'
}

/** A run's mark: its automation's, read from the event when an older host saved no rules. */
export function automationRunMark(run: AutomationRunMessage): AutomationRowMark {
  const source = run.automation.on?.[0]?.source ?? run.event?.source
  if (source) {
    return SOURCE_MARKS[source]
  }
  if (run.automation.once || run.wait) {
    return 'deadline'
  }
  return run.trigger === 'manual' ? 'manual' : 'schedule'
}

/** Where a wait's row is: still waiting, cancelled while it waited, ended (how, when this chat
 *  shows it), past its deadline, or gone from its host with how it ended shown elsewhere. */
export type WaitRowState =
  | { kind: 'waiting'; once: AutomationOnce }
  | { kind: 'cancelled'; at: number }
  | { kind: 'ended'; ending: WaitEnding }
  | { kind: 'past'; at: number }
  | { kind: 'over' }

/** The waits its bot's host still lists as waiting, as read at `readAt` on that host's clock. */
export type WaitHostRead = { botId: string; readAt: number; waitIds: ReadonlySet<string> }

/** The bot's Activity as a read of its waits; null until one lands, or from an older host. */
export function waitHostRead(
  botId: string,
  activity: { readAt?: number; waits?: readonly { automation: { id: string } }[] } | null
): WaitHostRead | null {
  return activity?.readAt !== undefined && activity.waits
    ? {
        botId,
        readAt: activity.readAt,
        waitIds: new Set(activity.waits.map((row) => row.automation.id))
      }
    : null
}

/** The host has stopped listing a wait saved before its read: it ran or was deleted. */
function goneFromHost(
  automation: Pick<BotAutomationFacts, 'id' | 'bot'>,
  madeAt: number | null | undefined,
  host: WaitHostRead | null | undefined
): boolean {
  return Boolean(
    host &&
    madeAt != null &&
    madeAt < host.readAt &&
    automation.bot?.botId === host.botId &&
    !host.waitIds.has(automation.id)
  )
}

/** A wait message's state: how it ended, else cancelled while it waited, else past its --by
 *  deadline (it ran then at the latest), else gone from its host's waits, else still waiting. */
export function waitRowState(
  message: {
    automationSaved?: { automation: Pick<BotAutomationFacts, 'id' | 'once' | 'bot'> }
    savedWaitEnded?: WaitEnding
    waitEnded?: { ending: WaitEnding }
    timestamp?: number | null
  },
  cancelledWaits: readonly { automationId: string; at: number }[] | undefined,
  now: number,
  host?: WaitHostRead | null
): WaitRowState | null {
  const ending = message.waitEnded?.ending ?? message.savedWaitEnded
  if (ending) {
    return { kind: 'ended', ending }
  }
  const automation = message.automationSaved?.automation
  if (!automation?.once) {
    return null
  }
  const cancelled = cancelledWaits?.find((entry) => entry.automationId === automation.id)
  if (cancelled) {
    return { kind: 'cancelled', at: cancelled.at }
  }
  const by = automation.once.by
  if (by !== undefined && by <= now) {
    return { kind: 'past', at: by }
  }
  return goneFromHost(automation, message.timestamp, host)
    ? { kind: 'over' }
    : { kind: 'waiting', once: automation.once }
}

export function waitRowLabel(state: WaitRowState, say: SayAutomationRun): string {
  switch (state.kind) {
    case 'waiting':
      return say('waiting')
    case 'cancelled':
      return say('cancelled')
    case 'ended':
    case 'past':
    case 'over':
      return say('waitOver')
  }
}

// Events where "replied" names what happened; others say only that it happened.
const REPLY_EVENTS = new Set([
  'slack.message',
  'slack.mentioned',
  'github.comment',
  'github.review_comment',
  'github.review',
  'linear.mentioned'
])

function waitsForReply(automation: Pick<BotAutomationFacts, 'on'>): boolean {
  return (automation.on ?? []).some((rule) => REPLY_EVENTS.has(`${rule.source}.${rule.event}`))
}

/** "Until 5 PM", "No deadline", "Nora replied", "No reply by 5 PM", "After 30 days"; empty when cancelled. */
export function waitRowStatus(
  automation: Pick<BotAutomationFacts, 'on'>,
  state: WaitRowState,
  { say, formatTime }: Pick<AutomationRunWording, 'say' | 'formatTime'>
): string {
  if (state.kind === 'waiting') {
    return state.once.by === undefined
      ? say('noDeadline')
      : say('until', { time: formatTime(state.once.by) })
  }
  if (state.kind === 'cancelled' || state.kind === 'past' || state.kind === 'over') {
    return ''
  }
  const { ending } = state
  const reply = waitsForReply(automation)
  switch (ending.kind) {
    case 'event':
      return reply && ending.actor ? say('replied', { actor: ending.actor }) : say('happened')
    case 'deadline': {
      const time = formatTime(ending.at)
      return reply ? say('noReplyBy', { time }) : say('nothingBy', { time })
    }
    case 'expired':
      return say('afterThirtyDays')
  }
}

/** When the row's time slot reads: when it was made, cancelled, or ended. */
export function waitRowTime(state: WaitRowState, madeAt: number | null): number | null {
  switch (state.kind) {
    case 'waiting':
      return madeAt
    case 'cancelled':
    case 'past':
      return state.at
    case 'ended':
      return state.ending.at
    case 'over':
      return null
  }
}

/** The opened wait's "Then" line. */
export function waitRowThen(once: AutomationOnce, wording: AutomationRunWording): string {
  return once.by === undefined
    ? wording.say('thenOnce')
    : wording.say('thenOnceBy', { time: wording.formatTime(once.by) })
}

/** Any row's accessible name but a run's: label, name, then whatever status and time it shows. */
export function automationRowAccessibleName(
  input: { label: string; name: string; status: string; time: string | null },
  say: SayAutomationRun
): string {
  const details = [input.status, input.time].filter(Boolean).join('. ')
  return say('rowAccessibleName', { label: input.label, name: input.name, details }).trim()
}
