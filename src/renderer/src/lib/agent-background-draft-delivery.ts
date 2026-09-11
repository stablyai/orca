import type { TuiAgent } from '../../../shared/tui-agent'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'
import { showAgentPasteCredentialPromptToast } from '@/lib/agent-paste-credential-prompt-notice'

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
    onUndelivered: (failure) =>
      failure === 'credential-prompt'
        ? showAgentPasteCredentialPromptToast(agent, true)
        : showAutomationPromptNotSentToast(agent)
  })
}
