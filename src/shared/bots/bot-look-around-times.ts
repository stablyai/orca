// Look around's schedule as a list of wall-clock times: a preset's hours or the owner's own times,
// evaluated as civil slots in the schedule’s zone.
import * as z from 'zod'
import {
  LOOK_AROUND_EVERY,
  LOOK_AROUND_MAX_TIMES,
  LOOK_AROUND_MIN_GAP_MINUTES,
  LOOK_AROUND_TIME_PATTERN,
  type BotLookAround
} from './bot-look-around'

const DAY_MINUTES = 24 * 60

function minutesOf(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return (hour ?? 0) * 60 + (minute ?? 0)
}

function timeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** Sorted, each once. */
function normalizedTimes(times: readonly string[]): string[] {
  return [...new Set(times)].sort()
}

/** The times the bot looks at, sorted: Custom's own, else its preset's hours. A Custom whose saved
 *  times are missing or unreadable looks at none, rather than at times the owner never chose. */
export function lookAroundTimes(setting: Pick<BotLookAround, 'every' | 'times'>): string[] {
  if (setting.every === 'custom') {
    return lookAroundTimesProblem(setting.times ?? []) ? [] : normalizedTimes(setting.times ?? [])
  }
  return LOOK_AROUND_EVERY[setting.every].map((hour) => timeOf(hour * 60))
}

/** Minutes between consecutive times, the last one wrapping to the first the next day. */
function gapsOf(times: readonly string[]): number[] {
  const minutes = times.map(minutesOf)
  return minutes.map((value, index) =>
    index + 1 < minutes.length
      ? minutes[index + 1]! - value
      : minutes.length > 1
        ? minutes[0]! + DAY_MINUTES - value
        : DAY_MINUTES
  )
}

export type LookAroundTimesProblem = 'empty' | 'tooMany' | 'invalid' | 'duplicate' | 'tooClose'

/** Why a Custom list can't be saved, or null. `tooClose` names the two times. */
export function lookAroundTimesProblem(
  times: readonly string[]
): { problem: LookAroundTimesProblem; times?: [string, string] } | null {
  if (times.length === 0) {
    return { problem: 'empty' }
  }
  if (times.length > LOOK_AROUND_MAX_TIMES) {
    return { problem: 'tooMany' }
  }
  if (times.some((time) => !LOOK_AROUND_TIME_PATTERN.test(time))) {
    return { problem: 'invalid' }
  }
  const sorted = [...times].sort()
  const repeat = sorted.find((time, index) => sorted[index + 1] === time)
  if (repeat) {
    return { problem: 'duplicate', times: [repeat, repeat] }
  }
  const gaps = gapsOf(sorted)
  const close = gaps.findIndex((gap) => gap < LOOK_AROUND_MIN_GAP_MINUTES)
  return close === -1
    ? null
    : { problem: 'tooClose', times: [sorted[close]!, sorted[(close + 1) % sorted.length]!] }
}

export const LOOK_AROUND_TIMES_RULE = `HH:MM times at least ${LOOK_AROUND_MIN_GAP_MINUTES} min apart (max ${LOOK_AROUND_MAX_TIMES})`

/** Custom times as an edit sends them: validated, then saved sorted. */
export const LookAroundTimesInput = z
  .array(z.string().trim())
  .superRefine((times, ctx) => {
    const found = lookAroundTimesProblem(times)
    if (found) {
      ctx.addIssue({
        code: 'custom',
        message:
          found.problem === 'tooClose' || found.problem === 'duplicate'
            ? `Look around times need ${LOOK_AROUND_TIMES_RULE}; ${found.times?.join(' and ')} are too close.`
            : `Look around times need ${LOOK_AROUND_TIMES_RULE}.`
      })
    }
  })
  .transform(normalizedTimes)

/** A saved `timezone` that means "follow the host's own clock", chosen on purpose (so a later edit
 *  never stamps a zone over it), as against no zone ever saved. */
export const LOOK_AROUND_HOST_CLOCK = 'host'

/** An IANA region name ("America/Los_Angeles", "Etc/GMT+5") or UTC, as the runtime spells it; null
 *  for abbreviations ("PST", "EST"), offsets ("+05:30"), legacy names ("PST8PDT"), wrong case, or a
 *  name the runtime doesn't know. Abbreviations are ambiguous ("EST" is Panama, with no DST). */
export function canonicalLookAroundTimeZone(zone: string): string | null {
  if (zone !== 'UTC' && !/^[A-Z][A-Za-z_-]*(\/[A-Za-z0-9_+-]+)+$/.test(zone)) {
    return null
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** The zone a schedule's times are read in: its own, or undefined for the host's clock (none saved,
 *  "host" chosen, or a saved zone this runtime can't read, which the status read reports). */
export function lookAroundZone(setting: Pick<BotLookAround, 'timezone'>): string | undefined {
  const zone = setting.timezone
  return zone && zone !== LOOK_AROUND_HOST_CLOCK && canonicalLookAroundTimeZone(zone)
    ? zone
    : undefined
}

/** A zone as an edit sends it, saved as the runtime spells it; null follows the host's clock. */
export const LookAroundTimeZoneInput = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .transform((zone, ctx) => {
    const canonical = canonicalLookAroundTimeZone(zone)
    if (!canonical) {
      ctx.addIssue({
        code: 'custom',
        message: `Unknown time zone "${zone}"; use an IANA name like America/Los_Angeles.`
      })
      return z.NEVER
    }
    return canonical
  })
  .nullable()

/** The shortest gap between looks, for "one interval after the first conversation". */
export function lookAroundIntervalMs(setting: Pick<BotLookAround, 'every' | 'times'>): number {
  const times = lookAroundTimes(setting)
  return (times.length > 0 ? Math.min(...gapsOf(times)) : DAY_MINUTES) * 60_000
}

/** The editor's zone, added to an edit of the schedule when the bot has none saved yet, so the
 *  times read as the owner meant them on a host in another zone (as automations save theirs). */
export function withEditorTimeZone<P extends { every?: unknown; times?: unknown }>(
  setting: Pick<BotLookAround, 'timezone'>,
  patch: P,
  editorZone: string | undefined
): P & { timezone?: string } {
  if (setting.timezone || !editorZone || (patch.every === undefined && patch.times === undefined)) {
    return patch
  }
  return { ...patch, timezone: editorZone }
}

/** "9 AM", "9:30 AM", in English for the chat line and the CLI. */
export function lookAroundTimeLabel(time: string): string {
  const total = minutesOf(time)
  const hour = Math.floor(total / 60)
  const minute = total % 60
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'AM' : 'PM'}`
}

/** "a, b and c". */
export function joinWithAnd(parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

const PRESET_TEXT = {
  'every-4h': ['Every 4 hours on weekdays, 8 AM to 8 PM', 'Every 4 hours, 8 AM to 8 PM'],
  'every-2h': ['Every 2 hours on weekdays, 8 AM to 8 PM', 'Every 2 hours, 8 AM to 8 PM'],
  'twice-daily': ['Twice a day on weekdays, 8 AM and 1 PM', 'Twice a day, 8 AM and 1 PM'],
  mornings: ['Weekday mornings at 8 AM', 'Each morning at 8 AM']
} as const

/** The whole schedule in one line, in English: "Weekdays at 9:30 AM and 2 PM". `zone` is added
 *  when given, for a reader whose own zone differs. */
export function lookAroundScheduleText(
  setting: Pick<BotLookAround, 'every' | 'times' | 'weekdaysOnly'>,
  zone?: string
): string {
  const text =
    setting.every !== 'custom'
      ? PRESET_TEXT[setting.every][setting.weekdaysOnly ? 0 : 1]
      : setting.times?.length
        ? `${setting.weekdaysOnly ? 'Weekdays' : 'Every day'} at ${joinWithAnd(lookAroundTimes(setting).map(lookAroundTimeLabel))}`
        : 'Custom times, none set'
  return zone ? `${text} (${zone})` : text
}

/** Throws, as a ZodError the RPC reports as a bad argument, when a schedule an edit leaves can't run
 *  as the owner set it: Custom needs valid times. Times kept while a preset is chosen, and a saved
 *  zone this runtime can't read (it falls back to the host's clock), never block an edit. */
export function assertLookScheduleRunnable(setting: Pick<BotLookAround, 'every' | 'times'>): void {
  if (setting.every !== 'custom') {
    return
  }
  z.array(z.string(), { error: `Custom Look around needs times: ${LOOK_AROUND_TIMES_RULE}.` })
    .pipe(LookAroundTimesInput)
    .parse(setting.times)
}
