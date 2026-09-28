// Reads what a question tool recorded as data: each question's id and secrecy from
// the call, and the reader's answers from the result. Each reader accepts only the
// shapes its agent is known to write; anything else yields no answers, so the ask
// row shows the questions alone rather than a guess.

import type { NativeChatAskAnswer } from './native-chat-types'

/** Joins the parts of one reply: chosen labels, then any text the reader typed. */
export const NATIVE_CHAT_ANSWER_PART_SEPARATOR = ' · '

/** Codex's question tool; only its results are read as Codex answers. */
export const CODEX_ASK_TOOL_NAME = 'request_user_input'

const CODEX_NOTE_PREFIX = 'user_note: '
const CODEX_RESULT_KEYS: ReadonlySet<string> = new Set(['answers'])
const CODEX_ENTRY_KEYS: ReadonlySet<string> = new Set(['answers'])

// Claude asks at most four questions at a time; this only bounds a malformed record.
const MAX_CLAUDE_ASK_QUESTIONS = 16
// Claude's stand-in answer when the reader typed a note but chose no option.
const CLAUDE_NOTES_ONLY_ANSWER = '(notes only)'
const CLAUDE_RESULT_KEYS: ReadonlySet<string> = new Set([
  'questions',
  'answers',
  'annotations',
  'response',
  'followUp',
  'afkTimeoutMs'
])
const CLAUDE_ANNOTATION_KEYS: ReadonlySet<string> = new Set(['preview', 'notes'])

/**
 * Claude's AskUserQuestion result record (`toolUseResult`) keeps the answers as
 * data beside the prose it hands the model, keyed by each question's exact text.
 * The prose varies by release and quotes answers unescaped, so only the data is
 * read: the chosen labels, then any note the reader typed. A string answer is
 * kept whole (it may be typed text, or labels already joined); a list is per label.
 */
export function claudeAskAnswers(toolUseResult: unknown): NativeChatAskAnswer[] | null {
  if (!isRecord(toolUseResult) || !hasOnlyKeys(toolUseResult, CLAUDE_RESULT_KEYS)) {
    return null
  }
  const { questions, answers, annotations, response, followUp, afkTimeoutMs } = toolUseResult
  if (
    !Array.isArray(questions) ||
    questions.length > MAX_CLAUDE_ASK_QUESTIONS ||
    !isRecord(answers) ||
    (annotations !== undefined && !isRecord(annotations)) ||
    (response !== undefined && typeof response !== 'string') ||
    (followUp !== undefined && typeof followUp !== 'boolean')
  ) {
    return null
  }
  // An idle timeout reports picks never submitted, and a typed response is sent in
  // place of the answers (unless it asks for follow-up questions).
  if (afkTimeoutMs !== undefined || ((response?.trim().length ?? 0) > 0 && followUp !== true)) {
    return null
  }
  const texts: string[] = []
  for (const entry of questions) {
    if (!isRecord(entry) || typeof entry.question !== 'string') {
      return null
    }
    texts.push(entry.question)
  }
  const asked = new Set(texts)
  for (const [question, value] of Object.entries(answers)) {
    if (!asked.has(question) || !(typeof value === 'string' || isStringArray(value))) {
      return null
    }
  }
  for (const entry of Object.values(annotations ?? {})) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, CLAUDE_ANNOTATION_KEYS) ||
      Object.values(entry).some((value) => typeof value !== 'string')
    ) {
      return null
    }
  }
  const entries: NativeChatAskAnswer[] = []
  for (const question of texts) {
    if (question.trim().length === 0) {
      continue
    }
    const value = answers[question]
    const annotation = annotations?.[question]
    const note = isRecord(annotation) ? annotation.notes : undefined
    const parts = [...(Array.isArray(value) ? value : [value]), note].filter(
      (part): part is string =>
        typeof part === 'string' && part.trim().length > 0 && part !== CLAUDE_NOTES_ONLY_ANSWER
    )
    if (parts.length > 0) {
      entries.push({ question, answer: parts })
    }
  }
  return entries.length > 0 ? entries : null
}

/**
 * Codex answers `request_user_input` with a JSON string keyed by each question's
 * id: `{"answers":{"<id>":{"answers":["<label>", "user_note: <typed>"]}}}`. A
 * refusal or an abort is plain text, and parses to null, as does any id the call
 * did not ask or any key or item of another shape. A question the reader left
 * unanswered (an empty list) has no entry.
 */
export function codexAskAnswers(
  output: string,
  questionIds: ReadonlySet<string>
): Map<string, string[]> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, CODEX_RESULT_KEYS) || !isRecord(parsed.answers)) {
    return null
  }
  const byId = new Map<string, string[]>()
  for (const [id, entry] of Object.entries(parsed.answers)) {
    if (
      !questionIds.has(id) ||
      !isRecord(entry) ||
      !hasOnlyKeys(entry, CODEX_ENTRY_KEYS) ||
      !isStringArray(entry.answers)
    ) {
      return null
    }
    const parts = entry.answers
      // The prefix is Codex's marker for typed text; the reader never wrote it.
      .map((part) =>
        part.startsWith(CODEX_NOTE_PREFIX) ? part.slice(CODEX_NOTE_PREFIX.length) : part
      )
      .filter((part) => part.trim().length > 0)
    if (parts.length > 0) {
      byId.set(id, parts)
    }
  }
  return byId
}

/** The question objects of a call's payload, decoded as the card's parser does:
 *  Codex delivers its arguments as a JSON string. */
export function askPayloadQuestions(input: unknown): Record<string, unknown>[] {
  let decoded = input
  if (typeof input === 'string') {
    try {
      decoded = JSON.parse(input)
    } catch {
      return []
    }
  }
  const list = isRecord(decoded) ? decoded.questions : null
  return Array.isArray(list) ? list.filter(isRecord) : []
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
