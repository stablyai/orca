import type { AskPrompt, AskQuestion } from './native-chat/input/native-chat-ask-types'

/** Return accepted immediately; nonblocking questions receive answers in later user messages ({questions:[{title, options?: string[]}]}). */
export const CODEX_ASYNC_QUESTION_TOOL = 'request_user_input_async'

export function parseCodexAsyncQuestionsInput(input: unknown): AskPrompt | null {
  if (!input || typeof input !== 'object' || !('questions' in input)) {
    return null
  }
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (raw && typeof raw === 'object' && 'title' in raw && typeof raw.title === 'string') {
      const options: unknown[] = 'options' in raw && Array.isArray(raw.options) ? raw.options : []
      questions.push({
        question: raw.title,
        multiSelect: false,
        options: options.flatMap((label) => (typeof label === 'string' ? [{ label }] : []))
      })
    }
  }
  return questions.length > 0 ? { questions, replyAsMessage: true } : null
}

/** Codex's default `chat.skip_question` key (Ctrl+]) as legacy, kitty and modifyOtherKeys bytes;
 *  a remapped key is not seen. */
const CODEX_SKIP_QUESTION_INPUTS: ReadonlySet<string> = new Set([
  '\x1d',
  '\x1b[93;5u',
  '\x1b[93;5:1u',
  '\x1b[27;5;93~'
])

export function isCodexSkipQuestionInput(data: string): boolean {
  return CODEX_SKIP_QUESTION_INPUTS.has(data)
}

const REPLY_OPEN = '<send_user_message_question_reply>'
const REPLY_CLOSE = '</send_user_message_question_reply>'

/** Null is ordinary input; an invalid addressed reply settles no questions. */
export function readCodexAsyncQuestionReply(prompt: string | undefined): [string, number][] | null {
  const json = replyBody(prompt)
  return json === null ? null : readReplyItems(json)
}

/** Keep reply correlation in the stored text, but show the person's question and answer. */
export function codexAsyncQuestionReplyMarkdown(text: string): string {
  const json = replyBody(text)
  if (json === null) {
    return text
  }
  const items = parseJson(json)
  if (!Array.isArray(items) || items.length === 0) {
    return text
  }
  const replies = items.flatMap((item) =>
    item && typeof item.question === 'string' && typeof item.answer === 'string'
      ? [`> ${item.question.replaceAll(/[\r\n]+/g, ' ')}\n\n${item.answer}`]
      : []
  )
  return replies.length === items.length ? replies.join('\n\n') : text
}

function replyBody(prompt: string | undefined): string | null {
  const body = prompt?.trim()
  return body?.startsWith(REPLY_OPEN) && body.endsWith(REPLY_CLOSE)
    ? body.slice(REPLY_OPEN.length, -REPLY_CLOSE.length)
    : null
}

function readReplyItems(json: string): [string, number][] {
  const items = parseJson(json)
  if (!Array.isArray(items)) {
    return []
  }
  return items.flatMap((item): [string, number][] => {
    const id =
      item && typeof item === 'object' && typeof item.questionItemId === 'string'
        ? parseJson(item.questionItemId)
        : null
    return Array.isArray(id) &&
      id.length === 3 &&
      id[0] === CODEX_ASYNC_QUESTION_TOOL &&
      typeof id[1] === 'string' &&
      Number.isSafeInteger(id[2]) &&
      id[2] >= 0
      ? [[id[1], id[2]]]
      : []
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
