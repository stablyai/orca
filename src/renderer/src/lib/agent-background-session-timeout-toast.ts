import { noticeGeneratedInputFailure } from './launch-agent-paste-timeout-notice'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'

export function showAutomationPromptNotSentToast(
  agent: TuiAgent,
  text: string,
  certainty?: 'not-sent' | 'unconfirmed',
  /** The host keeps this notice in its runtime session. */
  retained = false
): void {
  if (!retained) {
    noticeGeneratedInputFailure({ agent, text, certainty })
  }
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(agent)
  })
}
