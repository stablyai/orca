import type { AskPrompt } from './native-chat-ask-types'

// Live/status transcripts shorten question text differently; identity uses a prefix both retain.
const ASK_DISMISS_KEY_TEXT_PREFIX = 200

function askDismissKeyText(text: string | undefined): string | undefined {
  return text?.slice(0, ASK_DISMISS_KEY_TEXT_PREFIX)
}

/** Stable cross-platform identity for one canonical question prompt. */
export function nativeChatAskDismissKey(prompt: AskPrompt | null): string | null {
  if (!prompt) {
    return null
  }
  const questions = prompt.questions.map((question) => ({
    ...question,
    question: askDismissKeyText(question.question),
    header: askDismissKeyText(question.header),
    options: question.options.map((option) => ({
      ...option,
      description: askDismissKeyText(option.description)
    }))
  }))
  return `question:${JSON.stringify(questions)}`
}
