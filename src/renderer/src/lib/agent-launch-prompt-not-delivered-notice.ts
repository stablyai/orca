import { toast } from 'sonner'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * The agent started but the host kept its prompt: the agent never showed it was ready for input,
 * or a dialog it opened was still up when the wait ran out. Nothing was typed into the pane, so the
 * user is handed the text to paste themselves.
 */
export function showAgentLaunchPromptNotDeliveredNotice(args: {
  agent: TuiAgent
  prompt: string
}): void {
  toast.message(
    translate(
      'auto.lib.agent.launch.prompt.not.delivered.notice.message',
      "The agent started, but your prompt wasn't sent. Copy it and paste it once the agent is ready."
    ),
    {
      // The action is the only copy of the prompt, so the notice stays until the user dismisses it.
      duration: Infinity,
      action: {
        label: translate('auto.lib.agent.launch.prompt.not.delivered.notice.copy', 'Copy prompt'),
        onClick: () => {
          void window.api.ui.writeClipboardText(args.prompt).catch((error: unknown) => {
            console.error('Could not copy the launch prompt', error)
          })
        }
      }
    }
  )
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(args.agent)
  })
}
