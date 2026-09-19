import type {
  ScheduledMessage,
  ScheduledMessageTiming
} from '../../../../shared/scheduled-message-types'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'

/** Built by hand rather than via toISOString, which shifts into UTC and lands the
 *  user on the wrong day near midnight. */
export function toLocalDateTimeInputs(epochMs: number): { date: string; time: string } {
  const value = new Date(epochMs)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`
  }
}

/** Inverse of toLocalDateTimeInputs. Returns null for an incomplete or
 *  unparseable pair so the dialog can keep its confirm button disabled. */
export function fromLocalDateTimeInputs(date: string, time: string): number | null {
  if (!date || !time) {
    return null
  }
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  if ([year, month, day, hour, minute].some((part) => !Number.isFinite(part))) {
    return null
  }
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  // Date normalizes a local time that does not exist (02:30 on a spring-forward
  // night, day 31 of a 30-day month) into a moment the user never picked, so
  // round-trip the parts and refuse a mismatch.
  const roundTripped =
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day &&
    parsed.getHours() === hour &&
    parsed.getMinutes() === minute
  return roundTripped ? parsed.getTime() : null
}

function formatAbsolute(epochMs: number): string {
  try {
    const value = new Date(epochMs)
    const time = value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const isToday = new Date().toDateString() === value.toDateString()
    return isToday
      ? translate('auto.components.scheduledMessages.todayAt', 'Today {{time}}', { time })
      : `${value.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
  } catch {
    return translate('auto.components.scheduledMessages.unknownTime', 'an unknown time')
  }
}

/** Delegates to the app's locale-aware formatter; the sub-minute case stays local
 *  because Intl would render it as "this minute". */
function formatRelative(deltaMs: number): string {
  if (Math.abs(deltaMs) < 60_000) {
    return translate('auto.components.scheduledMessages.inLessThanAMinute', 'in under a minute')
  }
  return formatUiRelativeTime(deltaMs)
}

/** "Today 15:30 · in 2h 10m", or "When the agent is idle". */
export function formatScheduledMessageWhen(timing: ScheduledMessageTiming, now: number): string {
  if (timing.kind === 'when-idle') {
    return translate('auto.components.scheduledMessages.whenIdle', 'When the agent is idle')
  }
  const absolute = formatAbsolute(timing.sendAt)
  return timing.sendAt <= now
    ? translate('auto.components.scheduledMessages.dueNow', '{{absolute}} · due now', { absolute })
    : `${absolute} · ${formatRelative(timing.sendAt - now)}`
}

export function formatScheduledMessageStatus(message: ScheduledMessage): string | null {
  if (message.status === 'pending') {
    return null
  }
  if (message.failureReason === 'usage-limit-outlasted') {
    return translate(
      'auto.components.scheduledMessages.statusUsageLimitOutlasted',
      'Missed — the usage limit lasted too long to still send this'
    )
  }
  if (message.status === 'missed') {
    return translate(
      'auto.components.scheduledMessages.statusMissed',
      'Missed — Orca was closed when it came due'
    )
  }
  if (message.failureReason === 'no-pane') {
    return translate(
      'auto.components.scheduledMessages.statusNoPane',
      'Failed — the workspace had no open terminal'
    )
  }
  if (message.failureReason === 'no-agent') {
    return translate(
      'auto.components.scheduledMessages.statusNoAgent',
      'Failed — no agent was running in that terminal'
    )
  }
  return translate('auto.components.scheduledMessages.statusFailed', 'Failed to send')
}

/** Single-line preview for a table cell; agents get multi-paragraph prompts. */
export function previewScheduledMessageText(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstLine.trim()
}
