import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentProgramBlockReason } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

export function notifyBlockedAgentStartup(
  reason: AgentProgramBlockReason,
  request: string | undefined
): void {
  if (reason === 'unbuildable') {
    void import('../failure/agent-launch-failure')
      .then(({ notifyAgentLaunchFailure }) => notifyAgentLaunchFailure('hermes'))
      .catch((error: unknown) =>
        console.warn('[terminal] could not show the startup notice', error)
      )
    return
  }
  toast.message(
    reason === 'unavailable'
      ? translate('terminal.agentStartup.unavailable', 'The agent could not be found on this host.')
      : translate(
          'terminal.agentStartup.unknown',
          'The host could not verify the agent installation.'
        ),
    request
      ? {
          ...copyDroppedTextAction(request),
          description: translate(
            'terminal.startupPromptNotDelivered',
            "The startup prompt wasn't delivered."
          ),
          duration: Infinity
        }
      : undefined
  )
}

export function copyDroppedTextAction(text: string): {
  action: { label: string; onClick: () => void }
} {
  return {
    action: {
      label: translate('menu.copy', 'Copy'),
      onClick: () => {
        void window.api.ui.writeClipboardText(text)
      }
    }
  }
}
