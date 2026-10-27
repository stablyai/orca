import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import type { AgentType } from '../../../../shared/native-chat-types'
import {
  nativeChatAskRequiresTerminal,
  nativeChatStopSendsSecondEscape,
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from '../../../../shared/native-chat-agent-support'
import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  type AskAnswerSelection
} from '../../../../shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../../shared/native-chat/input/native-chat-ask-types'
import {
  sendNativeChatAskAnswer,
  sendNativeChatMessage,
  type NativeChatSendHandle
} from './native-chat-runtime-send'
import { inferQuestionAnsweredFromCurrentStatus } from '../terminal-pane/agent-question-answered-inference'

// Agent TUIs use Escape to cancel questions or deny approvals.
const ESC = '\x1b'

export type NativeChatInteractiveSend = {
  /** Claude-format selector answers settle only after every runtime write is verified. */
  sendAnswer: (
    prompt: AskPrompt,
    selections: AskAnswerSelection[],
    onDeliverySettled?: (delivered: boolean) => void
  ) => { settleAfterMs: number }
  /** Send a raw control string (e.g. an approval option number or ESC) as-is. */
  sendRaw: (raw: string) => void
  /** `sendRaw` that resolves to whether the write was acknowledged; unknown delivery is false. */
  sendRawVerified: (raw: string) => Promise<boolean>
  /** Stop delayed writes without interrupting the agent. */
  cancelPending: () => void
  /** Reject the question without interrupting the session; resolve true only for acknowledged Escape. */
  cancelAsk: () => Promise<boolean>
  cancel: () => void
}

/** Reuse composer routing to the live local/remote PTY; selector agents receive keystrokes, other agents pasted messages, and controls raw bytes. */
export function useNativeChatInteractiveSend(
  paneKey: string,
  targetPtyId: string | null,
  agent: AgentType
): NativeChatInteractiveSend {
  // Cancel delayed writes on a new send, Stop or unmount so detached views cannot keep writing PTY bytes.
  const inFlightRef = useRef<NativeChatSendHandle | null>(null)
  const cancelInFlight = useCallback(() => {
    inFlightRef.current?.cancel()
    inFlightRef.current = null
  }, [])
  // A split can rebind without unmounting; cancel during commit before delayed writes can target the replacement PTY.
  useLayoutEffect(() => cancelInFlight, [agent, cancelInFlight, paneKey, targetPtyId])

  const sendRaw = useCallback(
    (raw: string) => {
      if (!targetPtyId) {
        return
      }
      sendRuntimePtyInput(targetPtyId, raw, 'driving')
    },
    [targetPtyId]
  )

  const sendRawVerified = useCallback(
    (raw: string): Promise<boolean> =>
      targetPtyId
        ? sendRuntimePtyInputVerified(targetPtyId, raw, 'driving', {
            requireWriteSettlement: true
          }).catch(() => false)
        : Promise.resolve(false),
    [targetPtyId]
  )

  const sendAnswer = useCallback(
    (
      prompt: AskPrompt,
      selections: AskAnswerSelection[],
      onDeliverySettled?: (delivered: boolean) => void
    ): { settleAfterMs: number } => {
      if (nativeChatAskRequiresTerminal(agent)) {
        cancelInFlight()
        onDeliverySettled?.(false)
        return { settleAfterMs: 0 }
      }
      if (!targetPtyId || !hasAskAnswer(prompt, selections)) {
        return { settleAfterMs: 0 }
      }
      cancelInFlight()
      // Selector TUIs ignore pasted labels; Codex uses a different key sequence.
      const stepsAnswer = !prompt.replyAsMessage && shouldStepNativeChatAskAnswer(agent)
      const buildsCodexAnswer = resolveNativeChatTranscriptAgent(agent) === 'codex'
      // Capture the question baseline before paced/remote delivery so late settlement cannot clear a replacement question’s wait.
      const questionStatusBaseline = stepsAnswer
        ? useAppStore.getState().agentStatusByPaneKey[paneKey]
        : undefined
      let settledHandle: NativeChatSendHandle | null = null
      const onSettled = (delivered: boolean): void => {
        if (settledHandle && inFlightRef.current === settledHandle) {
          // Release completed sends’ timers, promises and prompt callbacks immediately.
          inFlightRef.current = null
        }
        if (delivered && stepsAnswer) {
          inferQuestionAnsweredFromCurrentStatus({
            paneKey,
            getStatusEntry: () => questionStatusBaseline,
            inferQuestionAnswered: (request) =>
              window.api.agentStatus.inferQuestionAnswered(request).catch((err) => {
                console.warn('[agent-question] native-chat inference failed:', err)
                return false
              })
          })
        }
        onDeliverySettled?.(delivered)
      }
      const handle: NativeChatSendHandle = stepsAnswer
        ? sendNativeChatAskAnswer(
            targetPtyId,
            buildsCodexAnswer
              ? buildCodexAskAnswerKeys(prompt, selections)
              : buildAskAnswerKeys(prompt, selections),
            onSettled
          )
        : sendNativeChatMessage(targetPtyId, formatAskAnswer(prompt, selections), {
            onDeliverySettled: onSettled
          })
      // These writes bypass xterm.onData; infer completion only after all paced steps so an early digit cannot dismiss the wait.
      settledHandle = handle
      inFlightRef.current = handle
      return {
        settleAfterMs: handle.settleAfterMs
      }
    },
    [paneKey, targetPtyId, agent, cancelInFlight]
  )

  const cancelAsk = useCallback(() => {
    cancelInFlight()
    if (nativeChatAskRequiresTerminal(agent)) {
      return Promise.resolve(false)
    }
    return sendRawVerified(ESC)
  }, [agent, cancelInFlight, sendRawVerified])

  const cancel = useCallback(() => {
    cancelInFlight()
    if (nativeChatStopSendsSecondEscape(agent) && targetPtyId) {
      // Pace the second Escape like an answer step so the TUI renders its confirm first.
      inFlightRef.current = sendNativeChatAskAnswer(targetPtyId, [{ raw: ESC }, { raw: ESC }])
      return
    }
    sendRaw(ESC)
  }, [agent, cancelInFlight, sendRaw, targetPtyId])

  return { sendAnswer, sendRaw, sendRawVerified, cancelPending: cancelInFlight, cancelAsk, cancel }
}
