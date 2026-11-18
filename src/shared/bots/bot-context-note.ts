// The row a bot chat shows for a turn that carried an edited SOUL.md or MEMORY.md; never their text.
// Older clients paint its `text` as a plain notice line.
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'

export const BOT_CONTEXT_NOTE_PRESENTATION = 'bot-context'

export type BotContextChange = 'soul' | 'memory'

export type BotContextNote = { botId: string; changed: BotContextChange[] }

export const BOT_CONTEXT_NOTE_COPY = {
  soul: 'Updated soul applied',
  memory: 'Memory edited outside this chat'
} as const

export function botContextNoteText(note: BotContextNote): string {
  return note.changed.map((change) => BOT_CONTEXT_NOTE_COPY[change]).join(' · ')
}

export function botContextNoteBody(
  note: BotContextNote
): AgentJournalPlainStatusItem & { botContext: BotContextNote } {
  return {
    kind: 'status',
    text: botContextNoteText(note),
    presentation: BOT_CONTEXT_NOTE_PRESENTATION,
    botContext: note
  }
}

/** The note on a journal item, or null when it carries none. */
export function botContextNoteOf(body: AgentJournalItemBody): BotContextNote | null {
  return 'botContext' in body ? readBotContextNote(body.botContext) : null
}

export function readBotContextNote(value: unknown): BotContextNote | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const note: Record<string, unknown> = { ...value }
  const changed = Array.isArray(note.changed)
    ? note.changed.filter(
        (change): change is BotContextChange => change === 'soul' || change === 'memory'
      )
    : []
  return typeof note.botId === 'string' && changed.length > 0
    ? { botId: note.botId, changed }
    : null
}
