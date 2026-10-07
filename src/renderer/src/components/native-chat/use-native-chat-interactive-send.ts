import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AgentType } from '../../../../shared/native-chat-types'
import {
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from '../../../../shared/native-chat-agent-support'
import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  type AskAnswerSelection,
  type AskPrompt
} from './native-chat-interactive-prompt'
import {
  sendNativeChatAskAnswer,
  sendNativeChatMessage,
  type NativeChatSendHandle
} from './native-chat-runtime-send'
import { inferQuestionAnsweredFromCurrentStatus } from '../terminal-pane/agent-question-answered-inference'

// ESC is the agent-TUI interrupt/cancel key over the PTY (matches how the
// composer forwards Escape). Used to cancel a question or deny an approval.
const ESC = '\x1b'

export type NativeChatInteractiveSend = {
  /** Deliver the answer to an AskUserQuestion prompt. Claude-format selectors
   *  verify every runtime write before reporting settlement. */
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
  /** Reject the active question without requesting session interruption; resolves to whether
   *  the Escape was acknowledged. */
  cancelAsk: () => Promise<boolean>
  /** Interrupt the active turn. */
  cancel: () => void
}

/**
 * Reuse the desktop composer's exact send path for the interactive cards:
 * resolve this tab's live ptyId + runtime owner settings, then write bytes via
 * `sendRuntimePtyInput` (which branches local pty:write vs remote runtime RPC,
 * so SSH panes work unchanged). Selector answers use their respective
 * selector keystrokes via `sendNativeChatAskAnswer`; other agents still go through
 * `sendNativeChatMessage`. Control strings (option digits, ESC) are written raw.
 */
export function useNativeChatInteractiveSend(
  terminalTabId: string,
  paneKey: string,
  targetPtyId: string | null,
  agent: AgentType
): NativeChatInteractiveSend {
  // The in-flight answer's cancel handle; cleared on a new send, on Stop, and on
  // unmount so a detached setTimeout chain can't keep writing PTY bytes after
  // the view is gone / the user switched away.
  const inFlightRef = useRef<NativeChatSendHandle | null>(null)
  const cancelInFlight = useCallback(() => {
    inFlightRef.current?.cancel()
    inFlightRef.current = null
  }, [])
  // Why: a split can be rebound without unmounting this view. Cancel during
  // commit so no delayed answer write can race the replacement PTY.
  useLayoutEffect(
    () => cancelInFlight,
    [agent, cancelInFlight, paneKey, targetPtyId, terminalTabId]
  )

  const sendRaw = useCallback(
    (raw: string) => {
      if (!targetPtyId) {
        return
      }
      sendRuntimePtyInput(
        getSettingsForAgentTabRuntimeOwner(terminalTabId),
        targetPtyId,
        raw,
        'driving'
      )
    },
    [terminalTabId, targetPtyId]
  )

  const sendRawVerified = useCallback(
    (raw: string): Promise<boolean> =>
      targetPtyId
        ? sendRuntimePtyInputVerified(
            getSettingsForAgentTabRuntimeOwner(terminalTabId),
            targetPtyId,
            raw,
            'driving',
            { requireWriteSettlement: true }
          ).catch(() => false)
        : Promise.resolve(false),
    [terminalTabId, targetPtyId]
  )

  const sendAnswer = useCallback(
    (
      prompt: AskPrompt,
      selections: AskAnswerSelection[],
      onDeliverySettled?: (delivered: boolean) => void
    ): { settleAfterMs: number } => {
      if (!targetPtyId || !hasAskAnswer(prompt, selections)) {
        return { settleAfterMs: 0 }
      }
      // Cancel any prior in-flight answer before starting a new one.
      cancelInFlight()
      const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
      // Selector TUIs ignore pasted labels; Codex uses a different key sequence.
      const stepsAnswer = shouldStepNativeChatAskAnswer(agent)
      const buildsCodexAnswer = resolveNativeChatTranscriptAgent(agent) === 'codex'
      // Why: pin the answered question's baseline BEFORE delivery. A late settle
      // callback (paced writes + remote acceptance can span seconds on SSH) must
      // not read the live status and mint a fresh baseline for a replacement
      // question that became current meanwhile — that would clear the new
      // question's wait. The server re-validates this captured baseline and
      // rejects a changed status, matching the terminal keystroke path.
      const questionStatusBaseline = stepsAnswer
        ? useAppStore.getState().agentStatusByPaneKey[paneKey]
        : undefined
      let settledHandle: NativeChatSendHandle | null = null
      const onSettled = (delivered: boolean): void => {
        if (settledHandle && inFlightRef.current === settledHandle) {
          // Why: a completed verified send otherwise retains its timers,
          // promises, and prompt callback until the next send or unmount.
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
            settings,
            targetPtyId,
            buildsCodexAnswer
              ? buildCodexAskAnswerKeys(prompt, selections)
              : buildAskAnswerKeys(prompt, selections),
            onSettled
          )
        : sendNativeChatMessage(settings, targetPtyId, formatAskAnswer(prompt, selections), {
            onDeliverySettled: onSettled
          })
      // Why: native-chat answer writes bypass xterm.onData. Infer only after
      // every paced selector write has fired, so an early digit in a multi-step
      // answer cannot dismiss the wait or cancel the remaining writes.
      settledHandle = handle
      inFlightRef.current = handle
      return {
        settleAfterMs: handle.settleAfterMs
      }
    },
    [terminalTabId, paneKey, targetPtyId, agent, cancelInFlight]
  )

  const cancelAsk = useCallback(() => {
    cancelInFlight()
    return sendRawVerified(ESC)
  }, [cancelInFlight, sendRawVerified])

  const cancel = useCallback(() => {
    cancelInFlight()
    if (resolveNativeChatTranscriptAgent(agent) === 'opencode' && targetPtyId) {
      // OpenCode confirms interruption with a second Escape; pace writes like mobile Stop.
      inFlightRef.current = sendNativeChatAskAnswer(
        getSettingsForAgentTabRuntimeOwner(terminalTabId),
        targetPtyId,
        [{ raw: ESC }, { raw: ESC }]
      )
      return
    }
    sendRaw(ESC)
  }, [agent, cancelInFlight, sendRaw, targetPtyId, terminalTabId])

  return { sendAnswer, sendRaw, sendRawVerified, cancelPending: cancelInFlight, cancelAsk, cancel }
}
