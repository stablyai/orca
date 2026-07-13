import { agentDeliversDraftViaNativePrefill } from '@/lib/agent-native-draft-prefill'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/types'

export function deliverLaunchPromptToAgentTab(args: {
  tabId: string
  agent: TuiAgent
  content: string
  submit: boolean
  forcePaste: boolean
  timeoutMs?: number
  onTimeout?: () => void
}): Promise<boolean> {
  const { tabId, agent, content, submit, forcePaste, timeoutMs, onTimeout } = args
  const shouldSeed =
    submit === true && content.trim().length > 0 && isNativeChatSupportedAgent(agent)

  if (shouldSeed) {
    useAppStore.getState().seedNativeChatLaunchPrompt({
      tabId,
      agent,
      text: content,
      createdAt: Date.now()
    })
  }

  // Why: native-prefill agents (claude/openclaude etc.) get the prompt at launch,
  // so pasteDraftWhenAgentReady returns false without pasting. That is a successful
  // native delivery, not a failure — don't flag the seeded bubble in that case.
  const deliversViaNativePrefill = agentDeliversDraftViaNativePrefill(agent, forcePaste)

  return pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit,
    forcePaste,
    timeoutMs,
    onTimeout
  }).then((delivered) => {
    if (shouldSeed && !delivered && !deliversViaNativePrefill) {
      useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
    }
    return delivered || deliversViaNativePrefill
  })
}
