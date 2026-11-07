import { noticeGeneratedInputFailure } from '../prompt/launch-agent-paste-timeout-notice'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

export function showAutomationPromptNotSentToast(
  agent: TuiAgent,
  text: string,
  certainty?: 'not-sent' | 'unconfirmed',
  /** The host keeps this notice in its runtime session. */
  retained = false,
  /** The accepted request this notice is of, and whether it was a prompt or notes. */
  operation?: { operationId?: string; submitted?: boolean }
): void {
  if (!retained) {
    noticeGeneratedInputFailure({
      agent,
      text,
      certainty,
      ...(operation?.operationId ? { operationId: operation.operationId } : {}),
      ...(operation?.submitted === false ? { submitted: false } : {})
    })
  }
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(agent)
  })
}
