import type { TuiAgent } from '../../../shared/tui-agent'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAgentLaunchPromptNotDeliveredNotice } from '@/lib/agent-launch-prompt-not-delivered-notice'

export function scheduleAgentBackgroundDraft(
  tabId: string,
  content: string,
  agent: TuiAgent
): void {
  void pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit: true,
    onTimeout: () => showAgentLaunchPromptNotDeliveredNotice({ agent, prompt: content })
  })
}
