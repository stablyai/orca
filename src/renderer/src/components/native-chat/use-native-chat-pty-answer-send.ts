import { useCallback } from 'react'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { NativeChatAsyncAnswerOutcome } from '../../../../shared/native-chat-async-question-answers'
import type { AgentType } from '../../../../shared/native-chat-types'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { nativeChatComposerTargetIsRemote } from './native-chat-composer-target'
import type { NativeChatOptimisticSendOutcome } from './native-chat-composer-types'
import { sendNativeChatMessageWithOutcome } from './native-chat-pty-answer-send'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'

/** Records an optimistic echo, as a composer send does; returns its pending id. */
export type NativeChatAsyncAnswerEcho = (
  text: string,
  imagePaths?: string[],
  asyncAnswers?: Readonly<Record<string, string>>
) => string | undefined

/** The terminal pane's answer seam: the same optimistic echo, per-PTY queue and pending-send
 *  tracking as a composer chat send, settled with what the write observed. */
export function useNativeChatPtyAnswerSend(args: {
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  canSend: boolean
  recordOptimistic: NativeChatAsyncAnswerEcho
  optimisticOutcome: NativeChatOptimisticSendOutcome
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
}): (text: string, answers: Record<string, string>) => Promise<NativeChatAsyncAnswerOutcome> {
  const { agent, terminalTabId, targetPtyId, canSend } = args
  const { recordOptimistic, optimisticOutcome, trackPendingSend } = args
  return useCallback(
    async (
      text: string,
      answers: Record<string, string>
    ): Promise<NativeChatAsyncAnswerOutcome> => {
      if (!targetPtyId || !canSend) {
        return 'rejected'
      }
      const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
      const started = sendNativeChatMessageWithOutcome(settings, targetPtyId, text)
      if (!started) {
        return 'rejected'
      }
      const { handle, outcome } = started
      // The echo carries the answers, so the card holds them until it lands or fails.
      const pendingId = recordOptimistic(text, undefined, answers)
      trackPendingSend(handle, pendingId)
      emitNativeChatMessageSent({
        agent,
        runtime: nativeChatComposerTargetIsRemote(targetPtyId) ? 'remote' : 'local'
      })
      const result = await outcome
      if (pendingId && result === 'rejected') {
        optimisticOutcome.reject(pendingId)
      } else if (pendingId && result === 'unknown') {
        optimisticOutcome.holdUnconfirmed(pendingId)
      }
      return result
    },
    [
      agent,
      canSend,
      optimisticOutcome,
      recordOptimistic,
      targetPtyId,
      terminalTabId,
      trackPendingSend
    ]
  )
}
