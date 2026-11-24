// An automation run's result in its bot's Home Chat: an Orca note the agent never receives on its own.
// It rides along with the person's next message, once; older clients paint its `text` as a plain line.
import { sliceAtCodeUnitLimit } from '../text/surrogate-safe-text-slice'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'

export const AUTOMATION_RESULT_NOTE_PRESENTATION = 'automation-result'

export type AutomationResultNote = {
  automationId: string
  automationName: string
  /** Names the bot in the note's read caption. */
  botName: string
  runId: string
  /** The run's own conversation. */
  sessionId?: string
  /** Picks the automation's icon, as its row in the Automations panel does. */
  trigger: 'schedule' | 'event'
  outcome: 'finished' | 'couldNotFinish'
  result: string
  at: number
  /** The person's message (client message id) the agent read this with; absent until then. */
  readWith?: string
}

/** Only a run's last message is kept; a longer one ends with "…". */
export const AUTOMATION_RESULT_NOTE_MAX_CHARS = 8_000

export const AUTOMATION_RESULT_PREAMBLE_LIMITS = {
  perResult: 400,
  results: 10,
  total: 4_000
} as const

export const AUTOMATION_RESULT_NOTE_COPY = {
  finished: 'finished',
  couldNotFinish: "couldn't finish",
  notRead: "{{name}} hasn't read this yet. It goes with your next message.",
  read: '{{name}} read this with your next message.',
  cleared: "Arrived before the chat was cleared. It won't go to {{name}}.",
  openRun: 'Open run',
  sentWithOne: 'Sent with 1 automation result',
  sentWithMany: 'Sent with {{count}} automation results'
} as const

/** The caption under a person's message that carried results; desktop translates the same copy. */
export function automationResultsCarriedText(count: number): string {
  return count === 1
    ? AUTOMATION_RESULT_NOTE_COPY.sentWithOne
    : AUTOMATION_RESULT_NOTE_COPY.sentWithMany.replace('{{count}}', String(count))
}

function clip(text: string, max: number): string {
  return text.length > max ? `${sliceAtCodeUnitLimit(text, max - 1).trimEnd()}…` : text
}

export function automationResultNoteClientMessageId(runId: string): string {
  return `automation-result:${runId}`
}

export function automationResultVerb(note: Pick<AutomationResultNote, 'outcome'>): string {
  return note.outcome === 'finished'
    ? AUTOMATION_RESULT_NOTE_COPY.finished
    : AUTOMATION_RESULT_NOTE_COPY.couldNotFinish
}

export function automationResultFirstLine(note: Pick<AutomationResultNote, 'result'>): string {
  return (
    note.result
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  )
}

/** The line a client that predates the note paints in its place. */
export function automationResultNoteText(note: AutomationResultNote): string {
  const line = automationResultFirstLine(note)
  return `${note.automationName} ${automationResultVerb(note)}${line ? `: ${line}` : ''}`
}

export function makeAutomationResultNote(
  note: Omit<AutomationResultNote, 'result' | 'readWith'> & { result: string }
): AutomationResultNote {
  return { ...note, result: clip(note.result.trim(), AUTOMATION_RESULT_NOTE_MAX_CHARS) }
}

/** A plain status row carrying the note; the field rides open, as status rows keep unknown fields. */
export type AutomationResultNoteItem = AgentJournalPlainStatusItem & {
  automationResult: AutomationResultNote
}

export function automationResultNoteBody(note: AutomationResultNote): AutomationResultNoteItem {
  return {
    kind: 'status',
    text: automationResultNoteText(note),
    presentation: AUTOMATION_RESULT_NOTE_PRESENTATION,
    automationResult: note
  }
}

/** The note on a journal item, or null when it carries none. */
export function automationResultNoteOf(body: AgentJournalItemBody): AutomationResultNote | null {
  return 'automationResult' in body ? readAutomationResultNote(body.automationResult) : null
}

/** A note as a newer host wrote it, or null for anything that isn't one. */
export function readAutomationResultNote(value: unknown): AutomationResultNote | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const note: Record<string, unknown> = { ...value }
  const strings = ['automationId', 'automationName', 'botName', 'runId', 'result'] as const
  if (
    strings.some((key) => typeof note[key] !== 'string') ||
    (note.trigger !== 'schedule' && note.trigger !== 'event') ||
    (note.outcome !== 'finished' && note.outcome !== 'couldNotFinish') ||
    typeof note.at !== 'number' ||
    (note.sessionId !== undefined && typeof note.sessionId !== 'string') ||
    (note.readWith !== undefined && typeof note.readWith !== 'string')
  ) {
    return null
  }
  return {
    automationId: String(note.automationId),
    automationName: String(note.automationName),
    botName: String(note.botName),
    runId: String(note.runId),
    ...(typeof note.sessionId === 'string' ? { sessionId: note.sessionId } : {}),
    trigger: note.trigger,
    outcome: note.outcome,
    result: String(note.result),
    at: note.at,
    ...(typeof note.readWith === 'string' ? { readWith: note.readWith } : {})
  }
}

/**
 * What the agent reads ahead of the person's words: unread results, oldest first, each cut at
 * `perResult`; past `results`, the oldest are only counted; the whole stays under `total`.
 */
export function automationResultsPreamble(
  notes: readonly AutomationResultNote[],
  formatTime: (at: number) => string
): string {
  const { perResult, results, total } = AUTOMATION_RESULT_PREAMBLE_LIMITS
  const ordered = [...notes].sort((a, b) => a.at - b.at)
  const head = `[Since your last message: ${ordered.length} automation result${
    ordered.length === 1 ? '' : 's'
  } arrived in this chat. You haven't seen them; the user saw them as notes.`
  const lines = ordered
    .slice(-results)
    .map(
      (note) =>
        `- ${formatTime(note.at)}, ${note.automationName}, ${automationResultVerb(note)}: ${clip(
          note.result.replace(/\s+/g, ' ').trim(),
          perResult
        )}`
    )
  const compose = (): string => {
    const earlier = ordered.length - lines.length
    return [head, ...(earlier > 0 ? [`+${earlier} earlier results`] : []), ...lines].join('\n')
  }
  // Past the total, the oldest shown results are only counted, so no line is cut twice.
  while (compose().length + 1 > total && lines.length > 1) {
    lines.shift()
  }
  return `${clip(compose(), total - 1)}]`
}
