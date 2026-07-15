import { useCallback, useLayoutEffect, useRef } from 'react'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AgentType } from '../../../../shared/native-chat-types'
import { shouldStepNativeChatAskAnswer } from '../../../../shared/native-chat-agent-support'
import {
  buildAskAnswerKeys,
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

// ESC is the agent-TUI interrupt/cancel key over the PTY (matches how the
// composer forwards Escape). Used to cancel a question or deny an approval.
const ESC = '\x1b'

export type NativeChatInteractiveSend = {
  /** Deliver the answer to an AskUserQuestion prompt. Returns the ms after which
   *  every scheduled write has fired (0 if nothing was sent) so the caller can
   *  keep the card up until the send settles. */
  sendAnswer: (prompt: AskPrompt, selections: AskAnswerSelection[]) => number
  /** Send a raw control string (e.g. an approval option number or ESC) as-is. */
  sendRaw: (raw: string) => void
  /** Stop delayed writes without interrupting the agent. */
  cancelPending: () => void
  /** Send ESC to interrupt — cancels a question / denies an approval. */
  cancel: () => void
}

/**
 * Reuse the desktop composer's exact send path for the interactive cards:
 * resolve this tab's live ptyId + runtime owner settings, then write bytes via
 * `sendRuntimePtyInput` (which branches local pty:write vs remote runtime RPC,
 * so SSH panes work unchanged). Claude's AskUserQuestion answers are delivered
 * as selector keystrokes (by option number, `sendNativeChatAskAnswer`); other
 * agents' question tools commit a pasted answer, so those still go through
 * `sendNativeChatMessage`. Control strings (option digits, ESC) are written raw.
 */
export function useNativeChatInteractiveSend(
  terminalTabId: string,
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
  useLayoutEffect(() => cancelInFlight, [cancelInFlight, targetPtyId, terminalTabId])

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
    (prompt: AskPrompt, selections: AskAnswerSelection[]): number => {
      if (!targetPtyId || !hasAskAnswer(prompt, selections)) {
        return 0
      }
      // Cancel any prior in-flight answer before starting a new one.
      cancelInFlight()
      const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
      // Claude's AskUserQuestion is an arrow-navigate selector: it commits by the
      // highlighted option, not a pasted label, so answer it with per-option
      // keystrokes (by option number), paced so each step renders before the next.
      // Other agents' question tools commit a pasted answer, so send label text.
      // Gate on the transcript agent (not `=== 'claude'`) so OpenClaude — which
      // runs the same selector — takes the keystroke path too.
      const handle: NativeChatSendHandle = shouldStepNativeChatAskAnswer(agent)
        ? sendNativeChatAskAnswer(settings, targetPtyId, buildAskAnswerKeys(prompt, selections))
        : sendNativeChatMessage(settings, targetPtyId, formatAskAnswer(prompt, selections))
      inFlightRef.current = handle
      return handle.settleAfterMs
    },
    [terminalTabId, targetPtyId, agent, cancelInFlight]
  )

  // Stop/cancel: drop any pending answer writes, then send ESC to interrupt.
  const cancel = useCallback(() => {
    cancelInFlight()
    sendRaw(ESC)
  }, [cancelInFlight, sendRaw])

  return { sendAnswer, sendRaw, cancelPending: cancelInFlight, cancel }
}
