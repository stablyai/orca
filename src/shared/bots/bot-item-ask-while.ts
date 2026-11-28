// What keeps a Needs-you ask open (`--while`): a worker that still runs, or a time not yet passed.
// Orca withdraws the ask when it settles; the shapes here are stored on the ask and its withdrawal.
import { BOT_ITEM_SNOOZE_MAX_MS } from './bot-item-snooze'

export type BotItemAskWhile = { kind: 'dispatch'; ref: string } | { kind: 'until'; at: number }

/** How a worker's Dispatch ended, as orchestration recorded it. */
export type BotItemWorkerEnd = 'completed' | 'failed' | 'stopped'

/** Why Orca withdrew an ask, as its status event keeps it. */
export type BotItemAskWithdrawn =
  | { kind: 'dispatch'; ref: string; state: BotItemWorkerEnd; title?: string }
  | { kind: 'until'; at: number; state: 'passed' }

const DISPATCH_REF = /^[^\s:]+$/
// A full date and time with seconds optional and an explicit zone, so no host guesses the offset.
const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/

/** The instant, or NaN for a day or clock time that doesn't exist (Feb 29, 2027; 24:00). */
function untilInstant(text: string): number {
  const match = ISO_WITH_ZONE.exec(text)
  if (!match) {
    return Number.NaN
  }
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = match
    .slice(1)
    .map((part) => Number(part ?? 0))
  const calendar = new Date(Date.UTC(year!, month! - 1, day!))
  const real =
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month! - 1 &&
    calendar.getUTCDate() === day &&
    hour! < 24 &&
    minute! < 60 &&
    second! < 60 &&
    zoneHour! <= 14 &&
    zoneMinute! < 60
  return real ? Date.parse(text) : Number.NaN
}

/** `--while` as typed; the message says what to type instead. */
export function parseBotItemAskWhile(
  value: string,
  now: number
): { ok: true; value: BotItemAskWhile } | { ok: false; message: string } {
  const word = value.trim()
  const colon = word.indexOf(':')
  const kind = colon === -1 ? word : word.slice(0, colon)
  const rest = colon === -1 ? '' : word.slice(colon + 1).trim()
  if (kind === 'dispatch') {
    return DISPATCH_REF.test(rest)
      ? { ok: true, value: { kind: 'dispatch', ref: rest } }
      : { ok: false, message: '--while dispatch: takes a worker id, e.g. dispatch:ctx_ab12cd34.' }
  }
  if (kind === 'until') {
    const at = untilInstant(rest)
    if (!Number.isFinite(at)) {
      return {
        ok: false,
        message:
          '--while until: takes a date and time with its zone, e.g. until:2026-11-27T09:00:00Z.'
      }
    }
    if (at <= now) {
      return { ok: false, message: '--while until: is already past; give a later time.' }
    }
    if (at - now > BOT_ITEM_SNOOZE_MAX_MS) {
      return { ok: false, message: '--while until: can be at most a year away.' }
    }
    return { ok: true, value: { kind: 'until', at } }
  }
  if (kind === 'pr') {
    return { ok: false, message: 'PR conditions are not supported yet; use dispatch: or until:.' }
  }
  return { ok: false, message: '--while takes dispatch:<worker id> or until:<date and time>.' }
}

/** A stored object's fields, read without trusting their types. */
function fieldsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** A kept `while`, or null when it isn't one this build reads. */
export function botItemAskWhileOf(value: unknown): BotItemAskWhile | null {
  const entry = fieldsOf(value)
  if (!entry) {
    return null
  }
  if (entry.kind === 'dispatch' && typeof entry.ref === 'string' && DISPATCH_REF.test(entry.ref)) {
    return { kind: 'dispatch', ref: entry.ref }
  }
  if (entry.kind === 'until' && typeof entry.at === 'number' && Number.isFinite(entry.at)) {
    return { kind: 'until', at: entry.at }
  }
  return null
}

/** A kept withdrawal, or null when it isn't one this build reads. */
export function botItemAskWithdrawnOf(value: unknown): BotItemAskWithdrawn | null {
  const entry = fieldsOf(value)
  if (!entry) {
    return null
  }
  if (
    entry.kind === 'dispatch' &&
    typeof entry.ref === 'string' &&
    (entry.state === 'completed' || entry.state === 'failed' || entry.state === 'stopped')
  ) {
    return {
      kind: 'dispatch',
      ref: entry.ref,
      state: entry.state,
      ...(typeof entry.title === 'string' && entry.title ? { title: entry.title } : {})
    }
  }
  if (entry.kind === 'until' && typeof entry.at === 'number' && entry.state === 'passed') {
    return { kind: 'until', at: entry.at, state: 'passed' }
  }
  return null
}

/** A `until:` time as asks and their withdrawals show it. */
export function botItemAskWhileTime(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(new Date(at))
}

/** What settles the ask, after "Withdraws " in the write's confirmation. */
export function botItemAskWhileWords(value: BotItemAskWhile, locale?: string): string {
  return value.kind === 'until'
    ? `at ${botItemAskWhileTime(value.at, locale)}`
    : `when worker ${value.ref} finishes`
}

/** The withdrawal's detail after "Ask withdrawn — ", in English: the note older clients show. */
export function botItemAskWithdrawnWords(value: BotItemAskWithdrawn, locale?: string): string {
  if (value.kind === 'until') {
    return `${botItemAskWhileTime(value.at, locale)} passed`
  }
  const worker = value.title ? `worker "${value.title}"` : `worker ${value.ref}`
  return value.state === 'completed'
    ? `${worker} finished`
    : value.state === 'failed'
      ? `${worker} failed`
      : `${worker} was stopped`
}

export function botItemAskWithdrawnNote(value: BotItemAskWithdrawn, locale?: string): string {
  return `Ask withdrawn — ${botItemAskWithdrawnWords(value, locale)}`
}
