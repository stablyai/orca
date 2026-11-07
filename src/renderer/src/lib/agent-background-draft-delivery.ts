import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'

export function scheduleAgentBackgroundDraft(
  tabId: string,
  content: string,
  agent: TuiAgent,
  /** The request's one id from a reused session's attempt (the allowed fresh-session fallback). */
  operationId?: string
): void {
  void pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit: true,
    ...(operationId ? { operationId } : {}),
    onTimeout: (certainty, retained, accepted) =>
      showAutomationPromptNotSentToast(agent, content, certainty, retained, {
        operationId: accepted
      })
  })
}
