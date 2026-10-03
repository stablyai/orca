import { translate } from '@/i18n/i18n'

export type WorkspaceSnoozePreset = 'one-hour' | 'five-hours' | 'tomorrow-morning' | 'next-week'

export const WORKSPACE_SNOOZE_PRESETS: readonly WorkspaceSnoozePreset[] = [
  'one-hour',
  'five-hours',
  'tomorrow-morning',
  'next-week'
]

const HOUR_MS = 60 * 60 * 1000
const MORNING_HOUR = 9

function atMorning(date: Date, daysAhead: number): number {
  const next = new Date(date)
  next.setDate(next.getDate() + daysAhead)
  next.setHours(MORNING_HOUR, 0, 0, 0)
  return next.getTime()
}

/** Local wall-clock time, so "tomorrow 9 AM" survives DST changes. */
export function resolveWorkspaceSnoozePresetWakeAt(
  preset: WorkspaceSnoozePreset,
  now: Date
): number {
  switch (preset) {
    case 'one-hour':
      return now.getTime() + HOUR_MS
    case 'five-hours':
      return now.getTime() + 5 * HOUR_MS
    case 'tomorrow-morning':
      return atMorning(now, 1)
    case 'next-week': {
      // Next Monday; on a Monday this skips to the following one.
      const daysUntilMonday = (8 - now.getDay()) % 7 || 7
      return atMorning(now, daysUntilMonday)
    }
  }
}

export function workspaceSnoozePresetLabel(preset: WorkspaceSnoozePreset): string {
  switch (preset) {
    case 'one-hour':
      return translate('auto.components.sidebar.workspaceSnooze.oneHour', '1 Hour')
    case 'five-hours':
      return translate('auto.components.sidebar.workspaceSnooze.fiveHours', '5 Hours')
    case 'tomorrow-morning':
      return translate(
        'auto.components.sidebar.workspaceSnooze.tomorrowMorning',
        'Tomorrow Morning'
      )
    case 'next-week':
      return translate('auto.components.sidebar.workspaceSnooze.nextWeek', 'Next Week')
  }
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

/** Time alone for today, so the common short snooze stays compact. */
export function formatWorkspaceSnoozeWakeAt(wakeAt: number, now: Date): string {
  const wake = new Date(wakeAt)
  return wake.toDateString() === now.toDateString()
    ? timeFormatter.format(wake)
    : dateTimeFormatter.format(wake)
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Formats local wall-clock time in the shape `<input type="datetime-local">` expects. */
export function toDatetimeLocalValue(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Offset-less date-times parse as local time; returns null for an empty or invalid value. */
export function parseDatetimeLocalValue(value: string): number | null {
  if (!value) {
    return null
  }
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}
