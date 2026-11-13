import { toast } from 'sonner'
import {
  activeAgentNotesSendFailureMessage,
  type ActiveAgentNotesSendResult
} from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'
import { translate } from '@/i18n/i18n'
import type { AgentMessageTarget } from '@/lib/agent-session/messaging/agent-message-target'
import { revealAgentTerminal } from '@/components/native-chat/selection-quotes/native-chat-workspace-selection'

/** The toast action that shows and focuses the terminal holding a pasted note. */
function goToNoteTerminalAction(
  worktreeId: string,
  target: AgentMessageTarget,
  onClick?: () => void
): { action?: { label: string; onClick: () => void } } {
  if (target.kind !== 'terminal') {
    return {}
  }
  return {
    action: {
      label: translate('resourceManager.pty.goToTerminal', 'Go to terminal'),
      onClick: () => {
        onClick?.()
        revealAgentTerminal(worktreeId, target)
      }
    }
  }
}

/**
 * Says a note sits unsent in an agent's terminal: "pasting" until the terminal has taken it in,
 * then "press Enter", in the same toast. It stays until closed or until that terminal gets focus.
 * `toastId` replaces that send's pending toast.
 */
export function showNotePastedToast(args: {
  worktreeId: string
  target: AgentMessageTarget
  agentLabel: string
  settleMs?: number
  toastId?: string | number
  readyMessage?: string
}): void {
  const { worktreeId, target, agentLabel, settleMs = 0, toastId } = args
  let timer: ReturnType<typeof setTimeout> | undefined
  const onFocusIn = (event: FocusEvent): void => {
    if (target.kind !== 'terminal' || !(event.target instanceof Element)) {
      return
    }
    const pane = `[data-terminal-tab-id="${CSS.escape(target.tabId)}"] [data-leaf-id="${CSS.escape(target.leafId)}"]`
    if (event.target.closest(pane)) {
      toast.dismiss(id)
      stop()
    }
  }
  const stop = (): void => {
    clearTimeout(timer)
    timer = undefined
    document.removeEventListener('focusin', onFocusIn)
  }
  const options = {
    duration: Infinity,
    onDismiss: stop,
    ...goToNoteTerminalAction(worktreeId, target, stop)
  }
  const pressEnter =
    args.readyMessage ??
    translate(
      'components.agentNotes.pastedPressEnter',
      'Note pasted into {{agent}}. Press Enter there to send.',
      { agent: agentLabel }
    )
  const id = toast.info(
    settleMs > 0
      ? translate('components.agentNotes.pastingNote', 'Pasting note into {{agent}}…', {
          agent: agentLabel
        })
      : pressEnter,
    { ...(toastId === undefined ? {} : { id: toastId }), ...options }
  )
  document.addEventListener('focusin', onFocusIn)
  if (settleMs > 0) {
    const deadline = Date.now() + settleMs
    const offerSubmit = (): void => {
      const remaining = deadline - Date.now()
      if (remaining > 0) {
        timer = setTimeout(offerSubmit, Math.min(remaining, 2_147_483_647))
        return
      }
      timer = undefined
      toast.info(pressEnter, { id, ...options })
    }
    timer = setTimeout(offerSubmit, Math.min(settleMs, 2_147_483_647))
  }
}

export function showWaitingNoteRefusalToast(
  args: Parameters<typeof showNotePastedToast>[0] & { readyMessage: string }
): void {
  if (args.settleMs && args.settleMs > 0) {
    showNotePastedToast(args)
  } else {
    toast.info(args.readyMessage, goToNoteTerminalAction(args.worktreeId, args.target))
  }
}

export function showNoteSendRefusalToast(args: {
  result: ActiveAgentNotesSendResult
  worktreeId: string
  target: AgentMessageTarget
  agentLabel: string
  toastId?: string | number
}): void {
  const { result, agentLabel } = args
  const message = activeAgentNotesSendFailureMessage(result.status, {
    explicitTarget: true,
    code: result.code,
    agent: agentLabel
  })
  if (result.code === 'terminal-draft-pending') {
    showWaitingNoteRefusalToast({ ...args, settleMs: result.pasteSettleMs, readyMessage: message })
  } else {
    toast.info(message, { id: args.toastId })
  }
}
