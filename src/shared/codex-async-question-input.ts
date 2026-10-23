import type { AskPrompt, AskQuestion } from './native-chat-ask-types'

/** Codex's non-blocking question: `{questions:[{title, options?: string[]}]}`. It
 *  returns `{"accepted":true}` at once and reads the answer from a later user message. */
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
