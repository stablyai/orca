import type { TuiAgent } from '../../../shared/types'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'

export function scheduleAgentBackgroundDraft(
  tabId: string,
  content: string,
  agent: TuiAgent,
  options?: { timeoutMs?: number }
): void {
  void pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit: true,
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    onTimeout: () => showAutomationPromptNotSentToast(agent)
  })
}
