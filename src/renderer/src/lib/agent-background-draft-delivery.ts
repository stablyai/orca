import type { AgentId } from '../../../shared/custom-agent'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'

export function scheduleAgentBackgroundDraft(tabId: string, content: string, agent: AgentId): void {
  void pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit: true,
    onTimeout: () => showAutomationPromptNotSentToast(agent)
  })
}
