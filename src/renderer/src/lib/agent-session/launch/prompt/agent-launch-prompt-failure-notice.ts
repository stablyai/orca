import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { structuredAgentLabel } from '../structured-agent-session-launch-label'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

export function notifyAgentLaunchPromptNotSent(agent: TuiAgent, content?: string): void {
  const message = translate(
    'agentLaunch.terminalPromptFailed',
    'Orca opened a terminal for {{value0}}, but could not pass it your prompt. Send the prompt in that terminal.',
    { value0: structuredAgentLabel(agent) }
  )
  if (content === undefined) {
    toast.error(message)
    return
  }
  toast.error(message, {
    action: {
      label: translate('components.agentSessionContinuation.copyPrompt', 'Copy prompt'),
      onClick: () => {
        void window.api.ui.writeClipboardText(content)
      }
    }
  })
}
