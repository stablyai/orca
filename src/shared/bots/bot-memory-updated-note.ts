import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'
import { redactSecretLike } from '../crash-reporting/crash-report-redaction'

export const BOT_MEMORY_UPDATED_NOTE = 'Memory updated'
const PRESENTATION = 'bot-memory-updated'
export const BotMemoryUpdatedNoteSchema = lazyZodSchema(() =>
  z.object({
    botId: z.string(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
    topics: z.array(z.string()),
    otherChanges: z.number().int().nonnegative()
  })
)
export type BotMemoryUpdatedNote = z.infer<typeof BotMemoryUpdatedNoteSchema>

/** Hide the whole value, including redactions retained by the memory history store. */
export function botMemoryReceiptValue(value: string): string {
  return redactSecretLike(value) !== value || /\[redacted[^\]]*\]/i.test(value)
    ? 'value hidden'
    : value
}

export function botMemoryUpdatedSummary(note: BotMemoryUpdatedNote): string {
  const counts = [
    [note.added.length, 'added'],
    [note.removed.length, 'removed'],
    [note.topics.length, note.topics.length === 1 ? 'note changed' : 'notes changed']
  ] as const
  const parts = counts.filter(([count]) => count > 0)
  const count = counts.reduce((total, [n]) => total + n, note.otherChanges)
  const summary =
    note.otherChanges > 0 || parts.length > 2
      ? `${count} ${count === 1 ? 'change' : 'changes'}`
      : parts.map(([n, word]) => `${n} ${word}`).join(', ')
  return summary ? `${BOT_MEMORY_UPDATED_NOTE} · ${summary}` : BOT_MEMORY_UPDATED_NOTE
}

export function botMemoryUpdatedNoteBody(
  note: BotMemoryUpdatedNote
): AgentJournalPlainStatusItem & { botMemoryUpdated: BotMemoryUpdatedNote } {
  const clean = {
    ...note,
    added: note.added.map(botMemoryReceiptValue),
    removed: note.removed.map(botMemoryReceiptValue),
    topics: note.topics.map(botMemoryReceiptValue)
  }
  return {
    kind: 'status',
    text: botMemoryUpdatedSummary(clean),
    presentation: PRESENTATION,
    botMemoryUpdated: clean
  }
}

export function botMemoryUpdatedNoteOf(body: AgentJournalItemBody): BotMemoryUpdatedNote | null {
  const parsed = BotMemoryUpdatedNoteSchema.safeParse(
    'botMemoryUpdated' in body ? body.botMemoryUpdated : null
  )
  return parsed.success ? botMemoryUpdatedNoteBody(parsed.data).botMemoryUpdated : null
}

export const BOT_MEMORY_UPDATED_COPY = {
  added: 'Added',
  removed: 'Removed',
  noteChanged: 'Note changed',
  indexChanged: 'MEMORY.md changed',
  openMemory: 'Open memory'
} as const

export type BotMemoryUpdatedRow = {
  change: 'added' | 'removed' | 'noteChanged'
  /** Stable among repeated values, for a list key. */
  key: string
  text: string
}

/** The receipt under a memory note: each change, values hidden where they look secret. */
export function botMemoryUpdatedRows(note: BotMemoryUpdatedNote): BotMemoryUpdatedRow[] {
  const seen = new Map<string, number>()
  const rows = (change: BotMemoryUpdatedRow['change'], lines: string[]) =>
    lines.map((line) => {
      const text = botMemoryReceiptValue(line)
      const occurrence = (seen.get(`${change}:${text}`) ?? 0) + 1
      seen.set(`${change}:${text}`, occurrence)
      return { change, key: `${text}:${occurrence}`, text }
    })
  return [
    ...rows('added', note.added),
    ...rows('removed', note.removed),
    ...rows('noteChanged', note.topics)
  ]
}
