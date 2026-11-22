// Tidy-up: a bot tidies its own memory overnight. The setting lives on the bot; absent means on,
// each night. A run's summary and the Home Chat line it leaves are read by desktop and phone alike.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'

export const TIDY_UP_EVERY_CHOICES = ['night', 'week'] as const
export type TidyUpEvery = (typeof TIDY_UP_EVERY_CHOICES)[number]

export const TIDY_UP_EVERY_LABELS: Record<TidyUpEvery, string> = {
  night: 'Each night after 3 AM',
  week: 'Once a week, after 3 AM'
}

/** Local hours a night's tidy-up starts in while the host is awake; a host asleep through them
 *  catches up once it is awake, until the next night starts. */
export const TIDY_UP_HOURS = { from: 3, until: 8 } as const

export const BotTidyUpSchema = z.object({
  on: z.boolean(),
  // A choice a newer client saved reads as the default rather than voiding the bot.
  every: z.enum(TIDY_UP_EVERY_CHOICES).catch('night').optional(),
  /** When it was last turned on; absent, it has been on since the bot was made. */
  since: z.number().optional()
})

export type BotTidyUp = { on: boolean; every: TidyUpEvery; since?: number }

export function botTidyUp(bot: { tidyUp?: z.infer<typeof BotTidyUpSchema> }): BotTidyUp {
  const since = bot.tidyUp?.since
  return {
    on: bot.tidyUp?.on ?? true,
    every: bot.tidyUp?.every ?? 'night',
    ...(since !== undefined ? { since } : {})
  }
}

/** The setting after an edit: turning it on stamps when, so only nights from then on catch up. */
export function patchTidyUp(
  current: BotTidyUp,
  patch: Partial<Pick<BotTidyUp, 'on' | 'every'>>,
  now: number
): BotTidyUp {
  const on = patch.on ?? current.on
  const since = on && !current.on ? now : current.since
  return {
    on,
    every: patch.every ?? current.every,
    ...(since !== undefined ? { since } : {})
  }
}

/** What one tidy-up changed, as its summary lists it. */
export const BotTidyUpSummarySchema = z.object({
  at: z.number(),
  tookMs: z.number(),
  chats: z.number(),
  /** Its one History row, which Undo reverts; null when only memory/ files changed. */
  rowId: z.string().nullable(),
  /** Facts it added from the owner's chats. */
  learned: z.array(z.string()),
  /** Facts a newer line replaced, moved to the archive marked so. */
  replaced: z.array(z.string()),
  filed: z.array(z.object({ topic: z.string(), count: z.number() })),
  /** Old lines moved to the archive. */
  moved: z.number(),
  /** Repeats merged into one line. */
  merged: z.number(),
  /** Why each op a tidy-up on operations asked for was skipped; absent on other tidy-ups. */
  skipped: z.array(z.string()).optional()
})

export type BotTidyUpSummary = z.infer<typeof BotTidyUpSummarySchema>

export function tidyUpChangeCount(summary: BotTidyUpSummary): number {
  return (
    summary.learned.length +
    summary.replaced.length +
    summary.filed.reduce((sum, { count }) => sum + count, 0) +
    summary.moved +
    summary.merged
  )
}

/** A bot's Tidy-up as Settings and the phone show it. */
export const BotTidyUpViewSchema = z.object({
  setting: z.object({ on: z.boolean(), every: z.enum(TIDY_UP_EVERY_CHOICES) }),
  /** The last tidy-up that changed something. */
  last: BotTidyUpSummarySchema.extend({ undone: z.boolean() }).nullable(),
  running: z.boolean(),
  /** Why it turned itself off, when it did after failing too often; null otherwise. */
  turnedOff: z.string().nullable(),
  /** The last run's failure, when it failed. */
  error: z.string().nullable(),
  /** `error` by code, for clients to translate; read with `readBotFailure`. */
  failure: z.unknown().optional()
})

export type BotTidyUpView = z.infer<typeof BotTidyUpViewSchema>

export type TidyNowRefusal = 'not_found' | 'unsupported' | 'paused' | 'running' | 'busy'

// The Home Chat line a tidy-up that changed something leaves; older clients paint its `text`.
export const TIDY_UP_NOTE_PRESENTATION = 'tidy-up'

export type BotTidyUpNote = { botId: string; changes: number }

export const TIDY_UP_NOTE_COPY = {
  tidied: 'Tidied memory · {{count}} changes'
} as const

export function tidyUpNoteText(note: BotTidyUpNote): string {
  return TIDY_UP_NOTE_COPY.tidied.replace('{{count}}', String(note.changes))
}

export function tidyUpNoteBody(
  note: BotTidyUpNote
): AgentJournalPlainStatusItem & { tidyUp: BotTidyUpNote } {
  return {
    kind: 'status',
    text: tidyUpNoteText(note),
    presentation: TIDY_UP_NOTE_PRESENTATION,
    tidyUp: note
  }
}

/** The note on a journal item, or null when it carries none. */
export function tidyUpNoteOf(body: AgentJournalItemBody): BotTidyUpNote | null {
  return 'tidyUp' in body ? readTidyUpNote(body.tidyUp) : null
}

export function readTidyUpNote(value: unknown): BotTidyUpNote | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const note: Record<string, unknown> = { ...value }
  return typeof note.botId === 'string' && typeof note.changes === 'number'
    ? { botId: note.botId, changes: note.changes }
    : null
}
