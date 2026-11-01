import { toast } from 'sonner'
import { getAgentLabel } from '../../../shared/agent-detection'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'

export function showGeneratedInputNotice(args: {
  agent?: TuiAgent
  text: string
  certainty?: 'not-sent' | 'unconfirmed'
  id?: string
  onDismiss?: () => void
}): string | number {
  const agent = args.agent ? getAgentLabel(args.agent) : 'The agent'
  const message =
    args.certainty === 'unconfirmed'
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
      label: translate('agentPrompt.copy', 'Copy prompt'),
      onClick: (event) => {
        event.preventDefault()
        void navigator.clipboard.writeText(args.text).catch(() => {})
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
      notified = true
      showGeneratedInputNotice({ agent: args.agent, text: args.content, certainty })
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}
