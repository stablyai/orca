import { showGeneratedInputNotice } from './launch-agent-paste-timeout-notice'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type { TuiAgent } from '../../../shared/tui-agent'

export function showAutomationPromptNotSentToast(
  agent: TuiAgent,
  text: string,
  certainty?: 'not-sent' | 'unconfirmed'
): void {
  showGeneratedInputNotice({ agent, text, certainty })
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(agent)
  })
}
