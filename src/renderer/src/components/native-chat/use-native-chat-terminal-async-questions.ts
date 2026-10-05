import { useMemo } from 'react'
import { nativeChatAsyncAnswerProgress } from '../../../../shared/native-chat-async-answer-progress'
import { NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT } from '../../../../shared/native-chat-async-questions'
import type { NativeChatAsyncQuestionsView } from '../../../../shared/native-chat-async-questions'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatOptimisticSendOutcome } from './native-chat-composer-types'
import {
  useNativeChatAsyncQuestions,
  type NativeChatAsyncQuestionsCardModel
} from './use-native-chat-async-questions'
import { nativeChatPendingAnswerHolding, type NativeChatPendingSend } from './native-chat-pending'
import {
  useNativeChatPtyAnswerSend,
  type NativeChatAsyncAnswerEcho
} from './use-native-chat-pty-answer-send'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'

/** The terminal pane's async question card: per-pane answer state and the pane-owned send
 *  lifecycle its writes belong to (cancelled on PTY swap, unmount and Stop). */
export function useNativeChatTerminalAsyncQuestions(args: {
  paneKey: string
  sessionId: string | null
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  canSend: boolean
  view: NativeChatAsyncQuestionsView | undefined
  /** The pane's optimistic echoes: one carrying answers holds them until it lands or fails. */
  pending: readonly NativeChatPendingSend[]
  /** The transcript the echoes land in, by which an echo that never will is let go. */
  messages: readonly NativeChatMessage[]
  recordOptimistic: NativeChatAsyncAnswerEcho
  optimisticOutcome: NativeChatOptimisticSendOutcome & { cancel: (pendingId: string) => void }
}): { model: NativeChatAsyncQuestionsCardModel; cancelPendingAnswers: () => void } {
  const { trackPendingSend, cancelPendingSends } = useNativeChatSendLifecycle(
    args.terminalTabId,
    args.targetPtyId,
    args.optimisticOutcome.cancel
  )
  const send = useNativeChatPtyAnswerSend({
    agent: args.agent,
    terminalTabId: args.terminalTabId,
    targetPtyId: args.targetPtyId,
    canSend: args.canSend,
    recordOptimistic: args.recordOptimistic,
    optimisticOutcome: args.optimisticOutcome,
    trackPendingSend
  })
  const { pending, messages } = args
  const progress = useMemo(
    () =>
      nativeChatAsyncAnswerProgress(
        pending.flatMap((entry) =>
          entry.asyncAnswers
            ? [
                {
                  answers: entry.asyncAnswers,
                  holding: nativeChatPendingAnswerHolding(entry, messages)
                }
              ]
            : []
        )
      ),
    [pending, messages]
  )
  const model = useNativeChatAsyncQuestions({
    scopeKey: JSON.stringify([args.paneKey, args.sessionId]),
    view: args.view ?? NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT,
    send,
    progress
  })
  return { model, cancelPendingAnswers: cancelPendingSends }
}
