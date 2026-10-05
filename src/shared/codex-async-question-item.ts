// Reads the questions a Codex `request_user_input_async` message carries
// (`delivery: "async"` + `questions`), bounded the way Codex's own editor bounds them.

import type { NativeChatBlock, NativeChatMessageAsyncQuestions } from './native-chat-types'

export type CodexAsyncQuestion = { title: string; options?: string[] }

/** Orca's display bound; Codex uses the same 512-byte budget for recovered titles. */
export const CODEX_ASYNC_QUESTION_TITLE_MAX_BYTES = 512
export const CODEX_ASYNC_QUESTION_OPTION_MAX_BYTES = 512
export const CODEX_ASYNC_QUESTION_MAX_OPTIONS = 32

const encoder = new TextEncoder()

function utf8Length(text: string): number {
  return encoder.encode(text).length
}

function clipToBytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) {
    return text
  }
  let clipped = ''
  let bytes = 0
  for (const char of text) {
    const charBytes = utf8Length(char)
    if (bytes + charBytes > maxBytes) {
      break
    }
    clipped += char
    bytes += charBytes
  }
  return clipped
}

function readQuestion(raw: unknown): CodexAsyncQuestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const title = 'title' in raw ? raw.title : undefined
  if (typeof title !== 'string' || title.trim().length === 0) {
    return null
  }
  const rawOptions = 'options' in raw ? raw.options : undefined
  if (rawOptions === undefined || rawOptions === null) {
    return { title: clipToBytes(title, CODEX_ASYNC_QUESTION_TITLE_MAX_BYTES) }
  }
  if (!Array.isArray(rawOptions) || rawOptions.some((option) => typeof option !== 'string')) {
    return null
  }
  // Same bounds as Codex's editor: the first 32, minus labels over 512 bytes.
  const options = rawOptions
    .slice(0, CODEX_ASYNC_QUESTION_MAX_OPTIONS)
    .filter(
      (option): option is string =>
        typeof option === 'string' &&
        option.trim().length > 0 &&
        utf8Length(option) <= CODEX_ASYNC_QUESTION_OPTION_MAX_BYTES
    )
  return {
    title: clipToBytes(title, CODEX_ASYNC_QUESTION_TITLE_MAX_BYTES),
    ...(options.length > 0 ? { options } : {})
  }
}

/** The validated question list, or null when the value is not one. */
export function readCodexAsyncQuestionList(value: unknown): CodexAsyncQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  const questions: CodexAsyncQuestion[] = []
  for (const raw of value) {
    const question = readQuestion(raw)
    if (!question) {
      return null
    }
    questions.push(question)
  }
  return questions
}

/** Questions of an async-delivered agent message (`delivery === 'async'`), else null. */
export function readCodexAsyncQuestions(item: unknown): CodexAsyncQuestion[] | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null
  }
  if (!('delivery' in item) || item.delivery !== 'async' || !('questions' in item)) {
    return null
  }
  return readCodexAsyncQuestionList(item.questions)
}

/** Questions from a `request_user_input_async` call's arguments (an object or its JSON text). */
export function readCodexAsyncQuestionCallArguments(input: unknown): CodexAsyncQuestion[] | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('questions' in value)) {
    return null
  }
  return readCodexAsyncQuestionList(value.questions)
}

export function codexAsyncQuestionListsEqual(
  a: readonly CodexAsyncQuestion[],
  b: readonly CodexAsyncQuestion[]
): boolean {
  return (
    a.length === b.length &&
    a.every((question, index) => {
      const other = b[index]
      const options = question.options ?? []
      const otherOptions = other?.options ?? []
      return (
        other !== undefined &&
        question.title === other.title &&
        options.length === otherOptions.length &&
        options.every((option, optionIndex) => option === otherOptions[optionIndex])
      )
    })
  )
}

/** A persisted block's async questions, or null when a journal holds a shape this build
 *  can't read (a newer build's, or damage); the field never gates the row itself. */
export function readNativeChatMessageAsyncQuestions(
  value: unknown
): NativeChatMessageAsyncQuestions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('questions' in value)) {
    return null
  }
  const questions = readCodexAsyncQuestionList(value.questions)
  if (!questions) {
    return null
  }
  const providerItemId = 'providerItemId' in value ? value.providerItemId : undefined
  return typeof providerItemId === 'string' && providerItemId.length > 0
    ? { providerItemId, questions }
    : { questions }
}

/** Records an async message's questions on its first text block, where hosts read them. */
export function attachCodexAsyncQuestions(
  blocks: NativeChatBlock[],
  item: unknown,
  providerItemId: string | null | undefined
): NativeChatBlock[] {
  const questions = readCodexAsyncQuestions(item)
  const textIndex = blocks.findIndex((block) => block.type === 'text')
  const textBlock = blocks[textIndex]
  if (!questions || textBlock?.type !== 'text') {
    return blocks
  }
  const attached = blocks.slice()
  attached[textIndex] = {
    ...textBlock,
    asyncQuestions: { ...(providerItemId ? { providerItemId } : {}), questions }
  }
  return attached
}
