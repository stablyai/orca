import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AgentType } from '../../../../shared/native-chat-types'
import {
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from '../../../../shared/native-chat-agent-support'
import {
  buildAskAnswerKeys,
  buildAskChatRowKeys,
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
   *  verify every runtime write before reporting settlement.
   *
   *  `strandedText` is the words that had no option to attach to. It follows the
   *  answer as a chat message once the selector settles, and survives a
   *  cancellation that retires the remaining keystrokes. */
  sendAnswer: (
    prompt: AskPrompt,
    selections: AskAnswerSelection[],
    onDeliverySettled?: (delivered: boolean) => void,
    strandedText?: string
  ) => {
    settleAfterMs: number
    waitsForVerifiedDelivery: boolean
    /** Clears the pane's question wait. Written bytes do not prove the agent
     *  accepted the answer, so the caller invokes this only once a confirmation
     *  signal lands (#16865). */
    confirmAnswered: () => void
  }
  /** Send a raw control string (e.g. an approval option number or ESC) as-is. */
  sendRaw: (raw: string) => void
  /** Send ordinary chat text, as the composer would. Used to escape a question
   *  to chat when the user's words have no option to attach to. */
  sendChatText: (text: string) => void
  /** Leave a question through the selector's own "Chat about this" row, then
   *  send `text` as an ordinary chat message once the selector has closed.
   *  The row rejects the question and restores the chat prompt, so the words
   *  never race a selector that is still torn down. */
  escapeToChat: (prompt: AskPrompt, text: string) => void
  /** Stop the in-flight answer's delayed keystrokes without interrupting the
   *  agent. Scoped to selector keystrokes: any stranded text still owed to chat
   *  is delivered, since it carries the user's own words. */
  cancelPending: () => void
  /** Send ESC to interrupt — cancels a question / denies an approval. */
  cancel: () => void
}

/**
 * Reuse the desktop composer's exact send path for the interactive cards:
 * resolve this tab's live ptyId + runtime owner settings, then write bytes via
 * `sendRuntimePtyInput` (which branches local pty:write vs remote runtime RPC,
 * so SSH panes work unchanged). Claude and Codex answers use their respective
 * selector keystrokes via `sendNativeChatAskAnswer`; other agents still go through
 * `sendNativeChatMessage`. Control strings (option digits, ESC) are written raw.
 */
export function useNativeChatInteractiveSend(
  terminalTabId: string,
  paneKey: string,
  targetPtyId: string | null,
  agent: AgentType
): NativeChatInteractiveSend {
  // The in-flight ANSWER's cancel handle; cleared on a new send, on Stop, and on
  // unmount so a detached setTimeout chain can't keep writing PTY bytes after
  // the view is gone / the user switched away. Only selector keystrokes are
  // enrolled: cancelling drops keystrokes a retired selector no longer reads,
  // and must never reach a write carrying the user's words.
  const inFlightRef = useRef<NativeChatSendHandle | null>(null)
  // Words the user typed with no option to attach to, owed to chat once the
  // answer settles. Held outside the handle: cancelling an answer drops
  // keystrokes the selector no longer needs, never the user's own text.
  const strandedTextRef = useRef<(() => void) | null>(null)
  const flushStrandedText = useCallback(() => {
    const send = strandedTextRef.current
    strandedTextRef.current = null
    send?.()
  }, [])
  const cancelInFlight = useCallback(() => {
    inFlightRef.current?.cancel()
    inFlightRef.current = null
    flushStrandedText()
  }, [flushStrandedText])
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
      sendRuntimePtyInput(getSettingsForAgentTabRuntimeOwner(terminalTabId), targetPtyId, raw)
    },
    [terminalTabId, targetPtyId]
  )

  const sendAnswer = useCallback(
    (
      prompt: AskPrompt,
      selections: AskAnswerSelection[],
      onDeliverySettled?: (delivered: boolean) => void,
      strandedText?: string
    ): {
      settleAfterMs: number
      waitsForVerifiedDelivery: boolean
      confirmAnswered: () => void
    } => {
      if (!targetPtyId || !hasAskAnswer(prompt, selections)) {
        return { settleAfterMs: 0, waitsForVerifiedDelivery: false, confirmAnswered: () => {} }
      }
      // Cancel any prior in-flight answer before starting a new one.
      cancelInFlight()
      const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
      const stranded = strandedText?.trim()
      if (stranded) {
        strandedTextRef.current = () => sendNativeChatMessage(settings, targetPtyId, stranded)
      }
      // Claude and Codex ignore pasted labels but have different selector state
      // machines; Grok commits pasted text. OpenClaude follows Claude's path.
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
      let confirmed = false
      const confirmAnswered = stepsAnswer
        ? (): void => {
            if (confirmed) {
              return
            }
            confirmed = true
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
        : (): void => {}
      let settledHandle: NativeChatSendHandle | null = null
      const onSettled = stepsAnswer
        ? (delivered: boolean): void => {
            if (settledHandle && inFlightRef.current === settledHandle) {
              // Why: a completed verified send otherwise retains its timers,
              // promises, and prompt callback until the next send or unmount.
              inFlightRef.current = null
            }
            if (delivered) {
              flushStrandedText()
            }
            onDeliverySettled?.(delivered)
          }
        : undefined
      const handle: NativeChatSendHandle = stepsAnswer
        ? sendNativeChatAskAnswer(
            settings,
            targetPtyId,
            buildsCodexAnswer
              ? buildCodexAskAnswerKeys(prompt, selections)
              : buildAskAnswerKeys(prompt, selections),
            onSettled
          )
        : sendNativeChatMessage(settings, targetPtyId, formatAskAnswer(prompt, selections))
      // Why: native-chat answer writes bypass xterm.onData, so settlement is
      // reported only after every paced selector write has fired — an early
      // digit in a multi-step answer must not cancel the remaining writes.
      settledHandle = handle
      inFlightRef.current = handle
      return {
        settleAfterMs: handle.settleAfterMs,
        waitsForVerifiedDelivery: onSettled !== undefined,
        confirmAnswered
      }
    },
    [terminalTabId, paneKey, targetPtyId, agent, cancelInFlight, flushStrandedText]
  )

  // Stop/cancel: drop any pending answer writes, then send ESC to interrupt.
  const cancel = useCallback(() => {
    cancelInFlight()
    sendRaw(ESC)
  }, [cancelInFlight, sendRaw])

  const escapeToChat = useCallback(
    (prompt: AskPrompt, text: string) => {
      const question = prompt.questions[0]
      if (!targetPtyId || !question) {
        return
      }
      cancelInFlight()
      const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
      const body = text.trim()
      // Why: the whole sequence stays outside `inFlightRef`. Selecting the chat
      // row resolves the ask, which clears the card's key and runs its cleanup
      // `cancelPending()` — enrolling either half here would cancel the row
      // keystroke and the user's words before they reach the PTY.
      sendNativeChatAskAnswer(settings, targetPtyId, buildAskChatRowKeys(question), () => {
        if (body) {
          sendNativeChatMessage(settings, targetPtyId, body)
        }
      })
    },
    [terminalTabId, targetPtyId, cancelInFlight]
  )

  const sendChatText = useCallback(
    (text: string) => {
      if (!targetPtyId || !text.trim()) {
        return
      }
      sendNativeChatMessage(
        getSettingsForAgentTabRuntimeOwner(terminalTabId),
        targetPtyId,
        text.trim()
      )
    },
    [terminalTabId, targetPtyId]
  )

  return {
    sendAnswer,
    sendRaw,
    sendChatText,
    escapeToChat,
    cancelPending: cancelInFlight,
    cancel
  }
}
