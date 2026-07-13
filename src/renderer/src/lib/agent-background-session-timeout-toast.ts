import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { AgentId } from '../../../shared/custom-agent'

export function showAutomationPromptNotSentToast(agent: AgentId): void {
  toast.message(
    translate(
      'auto.lib.launch.agent.background.session.4ca0651d56',
      "Your automation prompt wasn't sent — open the workspace and paste it."
    )
  )
  if (isTuiAgent(agent)) {
    track('agent_error', {
      error_class: 'paste_readiness_timeout',
      agent_kind: tuiAgentToAgentKind(agent)
    })
  }
}
