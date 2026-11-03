import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { generatedInputAgentName } from '../../../shared/generated-agent-input-notice'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'

export function showGeneratedInputNotice(args: {
  agent?: TuiAgent
  text: string
  certainty?: 'not-sent' | 'unconfirmed'
  /** False for an unsubmitted draft, which the user knows as notes. */
  submitted?: boolean
  id?: string
  onDismiss?: () => void
}): string | number {
  const agent = generatedInputAgentName(args.agent)
  // Unsubmitted drafts keep the existing "notes" term; only a submitted request is a prompt.
  const notes = args.submitted === false
  const unconfirmed = args.certainty === 'unconfirmed'
  const message = notes
    ? unconfirmed
      ? translate(
          'agentPrompt.notesUnconfirmed',
          '{{agent}} may have received part of your notes. Check its terminal before sending again.',
          { agent }
        )
      : translate(
          'agentPrompt.notesNotSent',
          "Your notes weren't sent to {{agent}}. Answer any dialog in its terminal, then paste your notes.",
          { agent }
        )
    : unconfirmed
      ? translate(
          'agentPrompt.deliveryUnconfirmed',
          '{{agent}} may have received part of your prompt. Check its terminal before sending again.',
          { agent }
        )
      : translate(
          'agentPrompt.notSent',
          "Your prompt wasn't sent to {{agent}}. Answer any dialog in its terminal, then paste your prompt.",
          { agent }
        )
  return toast.message(message, {
    id: args.id,
    duration: Infinity,
    closeButton: true,
    onDismiss: args.onDismiss,
    action: {
      label: notes
        ? translate('agentPrompt.copyNotes', 'Copy notes')
        : translate('agentPrompt.copy', 'Copy prompt'),
      // Copy never dismisses: the notice keeps the text until the user dismisses it. The desktop
      // clipboard goes through the main process, as every other Copy does; the page's own
      // clipboard write can be refused.
      onClick: (event) => {
        event.preventDefault()
        void window.api.ui.writeClipboardText(args.text).catch(() => {})
      }
    }
  })
}

export function createPasteReadinessTimeoutNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
  content: string
}): { onTimeout: (certainty?: 'not-sent' | 'unconfirmed') => void; wasNotified: () => boolean } {
  let notified = false
  return {
    wasNotified: () => notified,
    onTimeout: (certainty = 'not-sent') => {
      if (notified) {
        return
      }
      const tab = (useAppStore.getState().tabsByWorktree[args.worktreeId] ?? []).find(
        (candidate) => candidate.id === args.tabId
      )
      if (tab?.ptyId === null) {
        // The pane never spawned: a launch failure, which its caller reports as the sole notice.
        return
      }
      notified = true
      showGeneratedInputNotice({
        agent: args.agent,
        text: args.content,
        certainty,
        submitted: args.submitted
      })
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}
