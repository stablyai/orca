import type { NativeChatMessage } from '../native-chat-types'
import type { AsyncQuestionContributor } from './native-chat-ask'
import { quotedByQueuedAnswer } from './native-chat-ask-answer'
import type { AskQuestion } from './native-chat-ask-types'

export function addressAsyncQuestions(
  questions: AskQuestion[],
  toolName: string,
  callId: string | undefined
): AskQuestion[] {
  return callId === undefined
    ? questions
    : questions.map((question, index) => ({
        ...question,
        questionItemId: JSON.stringify([toolName, callId, index])
      }))
}

/** Ordinary input leaves async questions open; only a matching answer settles them. */
export function remainingAsyncQuestions(
  contributors: readonly AsyncQuestionContributor[],
  message: NativeChatMessage
): AsyncQuestionContributor[] {
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  return contributors.flatMap((contributor) => {
    const questions = contributor.questions.filter(
      (question) => !quotedByQueuedAnswer(question, [text])
    )
    return questions.length ? [{ ...contributor, questions }] : []
  })
}
