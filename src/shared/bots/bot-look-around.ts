// Look around: a bot reads what it can a few times a day and lists next steps under Up next.
// The setting lives on the bot; absent means on with the defaults, so existing bots get it too.
import * as z from 'zod'
import { containsSecretLike } from '../crash-reporting/crash-report-redaction'
import type { BotAgent } from '../bot-types'
import { startOfLocalDay } from '../automations/scheduling/automation-cron-occurrence'

/** Only these agents have a place where Orca can hold a run to reads. */
export const LOOK_AROUND_AGENTS = ['claude', 'codex'] as const satisfies readonly BotAgent[]

export function lookAroundSupported(agent: string): boolean {
  return LOOK_AROUND_AGENTS.some((entry) => entry === agent)
}

export const LOOK_AROUND_PRESETS = ['every-4h', 'every-2h', 'twice-daily', 'mornings'] as const
export type LookAroundPreset = (typeof LOOK_AROUND_PRESETS)[number]
/** The presets, or `custom`: the owner's own `times`. */
export const LOOK_AROUND_EVERY_CHOICES = [...LOOK_AROUND_PRESETS, 'custom'] as const
export type LookAroundEvery = (typeof LOOK_AROUND_EVERY_CHOICES)[number]

/** Local hours each preset looks at; nothing runs at night. */
export const LOOK_AROUND_EVERY: Record<LookAroundPreset, readonly number[]> = {
  'every-4h': [8, 12, 16, 20],
  'every-2h': [8, 10, 12, 14, 16, 18, 20],
  'twice-daily': [8, 13],
  mornings: [8]
}

/** Each preset as Settings and the chat line say it. */
export const LOOK_AROUND_EVERY_LABELS: Record<LookAroundPreset, string> = {
  'every-4h': 'Every 4 hours, 8 AM to 8 PM',
  'every-2h': 'Every 2 hours, 8 AM to 8 PM',
  'twice-daily': 'Twice a day, 8 AM and 1 PM',
  mornings: 'Each morning at 8 AM'
}

export const LOOK_AROUND_FOCUS_MAX_LENGTH = 500
/** Custom times a day, and how far apart, so a schedule can't quietly spend the owner's plan. */
export const LOOK_AROUND_MAX_TIMES = 12
export const LOOK_AROUND_MIN_GAP_MINUTES = 60
/** A wall-clock time, `HH:MM`, 24-hour. */
export const LOOK_AROUND_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export const BotLookAroundSchema = z.object({
  on: z.boolean(),
  // A preset a newer client saved reads as the default rather than voiding the bot.
  every: z.enum(LOOK_AROUND_EVERY_CHOICES).catch('every-4h'),
  weekdaysOnly: z.boolean(),
  /** What to look for, in the owner's words; empty means anything waiting on them. */
  focus: z.string().max(LOOK_AROUND_FOCUS_MAX_LENGTH),
  /** `every: 'custom'`'s times; kept while a preset is chosen, so Custom comes back as it was. */
  times: z
    .array(z.string().regex(LOOK_AROUND_TIME_PATTERN))
    .min(1)
    .max(LOOK_AROUND_MAX_TIMES)
    .optional()
    .catch(undefined),
  /** The IANA zone the times are read in; absent means the host's own clock. */
  timezone: z.string().min(1).max(100).optional().catch(undefined),
  /** When it was last turned on; a slot before it is never caught up. Absent: on all along. */
  since: z.number().optional()
})

export type BotLookAround = z.infer<typeof BotLookAroundSchema>

export const LOOK_AROUND_DEFAULTS: BotLookAround = {
  on: true,
  every: 'every-4h',
  weekdaysOnly: true,
  focus: ''
}

/** The bot's setting, or the defaults when it has never been changed. */
export function botLookAround(bot: { lookAround?: BotLookAround }): BotLookAround {
  return bot.lookAround ?? LOOK_AROUND_DEFAULTS
}

/** Which day a look was, on the viewer's wall clock, for "Looked yesterday 4:12 PM". */
export function lookedDay(at: number, now: number): 'today' | 'yesterday' | 'earlier' {
  const day = startOfLocalDay(at)
  const today = startOfLocalDay(now)
  return day === today ? 'today' : day === startOfLocalDay(today - 1) ? 'yesterday' : 'earlier'
}

/** An edit: the fields it names. `timezone`: omitted keeps the saved zone, null follows the host's
 *  clock from now on (saved as "host"), a name sets it. `editorTimeZone` is the editing client's own
 *  zone. `since` is the host's stamp, never an edit's. */
export type LookAroundPatch = Partial<Omit<BotLookAround, 'timezone' | 'since'>> & {
  timezone?: string | null
  editorTimeZone?: string
}

/** Only the fields an edit names change, so two quick edits never undo each other. Times alone
 *  mean Custom. A schedule edit on a bot with no saved zone saves the editor's, when it is the
 *  host's own (`hostTimeZone`); an editor elsewhere is asked which zone they mean instead. Read
 *  against the saved setting inside the host's update queue, so two first edits can't race.
 *  Turning it on stamps when, so a slot from before is never caught up. */
export function patchLookAround(
  setting: BotLookAround,
  patch: LookAroundPatch,
  now: number,
  hostTimeZone?: string
): BotLookAround {
  const on = patch.on ?? setting.on
  const since = on && !setting.on ? now : setting.since
  const times = patch.times ?? setting.times
  const stamp =
    !setting.timezone &&
    patch.timezone === undefined &&
    (patch.every !== undefined || patch.times !== undefined) &&
    patch.editorTimeZone !== undefined &&
    patch.editorTimeZone === hostTimeZone
      ? patch.editorTimeZone
      : undefined
  // null is the owner choosing the host's clock: saved as "host", so no later edit stamps a zone.
  const timezone = patch.timezone === null ? 'host' : (patch.timezone ?? setting.timezone ?? stamp)
  return {
    on,
    every: patch.every ?? (patch.times ? 'custom' : setting.every),
    weekdaysOnly: patch.weekdaysOnly ?? setting.weekdaysOnly,
    focus: patch.focus ?? setting.focus,
    ...(times ? { times } : {}),
    ...(timezone ? { timezone } : {}),
    ...(since !== undefined ? { since } : {})
  }
}

/** Whether an edit changes when looks run, so the whole schedule it leaves must be valid. */
export function patchesLookSchedule(patch: LookAroundPatch): boolean {
  return (
    patch.every !== undefined ||
    patch.times !== undefined ||
    patch.timezone !== undefined ||
    patch.weekdaysOnly !== undefined ||
    patch.on === true
  )
}

export const SUGGESTION_LIMITS = {
  title: 80,
  why: 400,
  ask: 2000,
  /** Per look. */
  perRun: 5,
  /** Shown before "Show N more". */
  shown: 3
} as const

export const SUGGESTION_SOURCES = ['slack', 'linear', 'github'] as const
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number]

/** One next step, as clients draw it. */
export type Suggestion = {
  id: string
  title: string
  why: string
  /** The message Start puts in the bot's message box. */
  ask: string
  link?: string
  /** Read from the link's host, for its mark and label. */
  source?: SuggestionSource
  createdAt: number
}

export type UpNextState = {
  lastLookedAt?: number
  /** How long the last look took. */
  tookMs?: number
  nextAt?: number
  /** A slot is owed now, on time or caught up after the host slept; it starts once the host is in
   *  full wake. */
  dueNow?: true
  /** ...held there because the machine is asleep or just woke. */
  nextHeld?: true
  /** When a due slot's catch-up ends (the next slot, or the day's end): it runs if it can start by
   *  then, else it's skipped. */
  nextGraceEndsAt?: number
  /** A slot before `nextAt` that won't run, because a Look now started just before it. */
  nextSkipped?: { at: number; lookedAt: number }
  /** The zone the schedule's times are read in: the setting's, else the host's. */
  timeZone?: string
  /** The host's own zone, for asking which zone an edit means when the viewer's differs. */
  hostTimeZone?: string
  /** The latest slot that passed without a look. */
  missedAt?: number
  /** The last look waited for the machine to settle after this slot. */
  lastLateFor?: number
  failedInARow?: number
  /** A listed time that failed or went by unrun at least twice in its last `of` scheduled slots;
   *  `scheduledFor` is its latest such slot. */
  repeatTrouble?: { scheduledFor: number; failed: number; missed: number; of: number }
  /** The saved zone can't be read on this host, so the times follow the host's clock until fixed. */
  zoneUnreadable?: true
  /** A slot missed while the machine slept runs later the same day. */
  catchUp?: true
  running: boolean
  /** The running look's session, whose steps clients can show; absent while no look runs. */
  runSessionId?: string
  /** The last finished look's session, so clients can read whether its usage limit stopped it. */
  lastSessionId?: string
  /** When the owner last saw Up next, 0 if never; suggestions made after it are new. */
  seenAt: number
  /** Why the last look failed; its older suggestions stay listed. */
  error?: string
}

/** The bot's Up next list and when it last looked; absent when Look around is off. */
export type BotUpNext = { state: UpNextState; items: Suggestion[] }

/** A link as the thing it names: lower case, no query or fragment, and no tail past a GitHub PR or
 *  issue number or a Linear issue key, so `…/pull/12/files#r1` and `…/pull/12` are one. */
function normalizedLink(link: string): string | null {
  try {
    const url = new URL(link)
    const parts = url.pathname.toLowerCase().split('/').filter(Boolean)
    const github = parts.findIndex((part) => part === 'pull' || part === 'issues')
    const linear = parts.indexOf('issue')
    const kept =
      github !== -1 && /^\d+$/.test(parts[github + 1] ?? '')
        ? parts.slice(0, github + 2)
        : linear !== -1 && parts[linear + 1]
          ? parts.slice(0, linear + 2)
          : parts
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}/${kept.join('/')}`
  } catch {
    return null
  }
}

/** What makes two suggestions the same: the thing their link names, else their title. */
export function suggestionKey(suggestion: { title: string; link?: string }): string {
  const link = suggestion.link ? normalizedLink(suggestion.link) : null
  return link ? `link:${link}` : `title:${suggestionTitleKey(suggestion.title)}`
}

/** Titles match ignoring case and spacing, so a reworded-by-whitespace title is the same one. */
export function suggestionTitleKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function suggestionSource(link: string | undefined): SuggestionSource | undefined {
  if (!link) {
    return undefined
  }
  try {
    const host = new URL(link).hostname
    if (host === 'slack.com' || host.endsWith('.slack.com')) {
      return 'slack'
    }
    if (host === 'linear.app' || host.endsWith('.linear.app')) {
      return 'linear'
    }
    return host === 'github.com' || host.endsWith('.github.com') ? 'github' : undefined
  } catch {
    return undefined
  }
}

/** A short name for a suggestion's link: `repo#12` or `repo` for GitHub, the issue key for Linear, else the host. */
export function suggestionLinkLabel(link: string): string {
  try {
    const url = new URL(link)
    const parts = url.pathname.split('/').filter(Boolean)
    const github = /^(pull|issues)$/.test(parts[2] ?? '') && /^\d+$/.test(parts[3] ?? '')
    if (suggestionSource(link) === 'github' && parts[1]) {
      return github ? `${parts[1]}#${parts[3]}` : parts[1]
    }
    const linearIssue = parts.indexOf('issue')
    if (suggestionSource(link) === 'linear' && linearIssue !== -1 && parts[linearIssue + 1]) {
      return parts[linearIssue + 1]
    }
    return url.hostname.replace(/^www\./, '')
  } catch {
    return link
  }
}

/** Credential-shaped query or fragment names a link could carry, e.g. `?access_token=`. */
const CREDENTIAL_PARAM =
  /token|secret|passw|api[_-]?key|access[_-]?key|signature|^sig$|auth|credential|session/i

/** A link that names a credential in its text, or in a query or fragment parameter. */
export function linkCarriesCredential(link: string): boolean {
  if (containsSecretLike(link)) {
    return true
  }
  try {
    const url = new URL(link)
    const names = [
      ...url.searchParams.keys(),
      ...new URLSearchParams(url.hash.replace(/^#/, '')).keys()
    ]
    return (
      url.username !== '' ||
      url.password !== '' ||
      names.some((name) => CREDENTIAL_PARAM.test(name))
    )
  } catch {
    return true
  }
}
