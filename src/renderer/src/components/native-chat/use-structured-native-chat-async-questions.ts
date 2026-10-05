import { useCallback, useMemo } from 'react'
import type { NativeChatAsyncAnswerOutcome } from '../../../../shared/native-chat-async-question-answers'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { structuredAsyncAnswerProgress } from './structured-agent-session-async-answer-progress'
import {
  useNativeChatAsyncQuestions,
  type NativeChatAsyncQuestionsCardModel
} from './use-native-chat-async-questions'

/** The structured pane's async question card, answered through the outbox. A saved entry holds
 *  the answer from then on (`queued`), so the card's own edits clear; where it stands after
 *  that is read from the outbox. */
export function useStructuredNativeChatAsyncQuestions(
  paneKey: string,
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'sendAsyncAnswer' | 'outbox' | 'asyncQuestions'
  >
): NativeChatAsyncQuestionsCardModel {
  const { sendAsyncAnswer, outbox } = controller
  const send = useCallback(
    (text: string, answers: Record<string, string>) =>
      Promise.resolve<NativeChatAsyncAnswerOutcome>(
        sendAsyncAnswer(text, answers) ? 'queued' : 'rejected'
      ),
    [sendAsyncAnswer]
  )
  const progress = useMemo(() => structuredAsyncAnswerProgress(outbox), [outbox])
  // The composer's scope: a withdrawn answer is handed back under the same key.
  return useNativeChatAsyncQuestions({
    scopeKey: paneKey,
    view: controller.asyncQuestions,
    send,
    progress
  })
}
