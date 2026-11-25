// Look around: a bot reads what it can a few times a day and lists next steps under Up next.
// The setting lives on the bot; absent means on with the defaults, so existing bots get it too.
import type { BotFailure } from './bot-failure-copy'
import * as z from 'zod'
import { containsSecretLike } from '../crash-reporting/crash-report-redaction'
import type { BotAgent } from '../bot-types'
import { startOfLocalDay } from '../automations/scheduling/automation-cron-occurrence'

/** Only these agents have a place where Orca can hold a run to reads. */
export const LOOK_AROUND_AGENTS = ['claude', 'codex'] as const satisfies readonly BotAgent[]

export function lookAroundSupported(agent: string): boolean {
  return LOOK_AROUND_AGENTS.some((entry) => entry === agent)
}

export const LOOK_AROUND_EVERY_CHOICES = [
  'every-4h',
  'every-2h',
  'twice-daily',
  'mornings'
] as const
export type LookAroundEvery = (typeof LOOK_AROUND_EVERY_CHOICES)[number]

/** Local hours each preset looks at; nothing runs at night. */
export const LOOK_AROUND_EVERY: Record<LookAroundEvery, readonly number[]> = {
  'every-4h': [8, 12, 16, 20],
  'every-2h': [8, 10, 12, 14, 16, 18, 20],
  'twice-daily': [8, 13],
  mornings: [8]
}

/** Each preset as Settings and the chat line say it. */
export const LOOK_AROUND_EVERY_LABELS: Record<LookAroundEvery, string> = {
  'every-4h': 'Every 4 hours, 8 AM to 8 PM',
  'every-2h': 'Every 2 hours, 8 AM to 8 PM',
  'twice-daily': 'Twice a day, 8 AM and 1 PM',
  mornings: 'Each morning at 8 AM'
}

export const LOOK_AROUND_FOCUS_MAX_LENGTH = 500

export const BotLookAroundSchema = z.object({
  on: z.boolean(),
  // A preset a newer client saved reads as the default rather than voiding the bot.
  every: z.enum(LOOK_AROUND_EVERY_CHOICES).catch('every-4h'),
  weekdaysOnly: z.boolean(),
  /** What to look for, in the owner's words; empty means anything waiting on them. */
  focus: z.string().max(LOOK_AROUND_FOCUS_MAX_LENGTH),
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

/** Only the fields an edit names change, so two quick edits never undo each other. Turning it on
 *  stamps when, so a slot from before is never caught up. */
export function patchLookAround(
  setting: BotLookAround,
  patch: Partial<Omit<BotLookAround, 'since'>>,
  now: number
): BotLookAround {
  const on = patch.on ?? setting.on
  const since = on && !setting.on ? now : setting.since
  return {
    on,
    every: patch.every ?? setting.every,
    weekdaysOnly: patch.weekdaysOnly ?? setting.weekdaysOnly,
    focus: patch.focus ?? setting.focus,
    ...(since !== undefined ? { since } : {})
  }
}

/** The schedule as a cron line the automation scheduler evaluates, on the host's wall clock. */
export function lookAroundSchedule(setting: Pick<BotLookAround, 'every' | 'weekdaysOnly'>): string {
  return `0 ${LOOK_AROUND_EVERY[setting.every].join(',')} * * ${setting.weekdaysOnly ? '1-5' : '*'}`
}

/** Hours between looks, for "one interval after the first conversation". */
export function lookAroundIntervalMs(every: LookAroundEvery): number {
  const [first, second] = LOOK_AROUND_EVERY[every]
  const gap = first !== undefined && second !== undefined ? second - first : 24
  return gap * 60 * 60 * 1000
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
  /** A slot the host slept through is owed now; it starts once the host is in full wake. */
  dueNow?: true
  running: boolean
  /** The running look's session, whose steps clients can show; absent while no look runs. */
  runSessionId?: string
  /** The last finished look's session, so clients can read whether its usage limit stopped it. */
  lastSessionId?: string
  /** When the owner last saw Up next, 0 if never; suggestions made after it are new. */
  seenAt: number
  /** Why the last look failed; its older suggestions stay listed. */
  error?: string
  /** `error` by code, for clients to translate; read with `readBotFailure`. */
  failure?: BotFailure
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
