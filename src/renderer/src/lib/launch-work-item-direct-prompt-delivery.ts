import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../shared/tui-agent'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { pasteDirectWorkItemDraftWhenAgentReady } from '@/lib/launch-work-item-direct-agent'

export function deliverDirectWorkItemPrompt(args: {
  primaryTabId: string | null
  effectiveAgent: TuiAgent | null
  draftContent: string
  promptDelivery: 'draft' | 'submit-after-ready'
  structuredSessionRequired: boolean
  startupPlan: AgentStartupPlan | null
  draftLaunchedNatively: boolean
}): boolean {
  if (args.structuredSessionRequired) {
    return false
  }
  if (args.promptDelivery === 'draft' && args.primaryTabId && args.effectiveAgent) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: args.primaryTabId,
      agent: args.effectiveAgent,
      text: args.draftContent
    })
  }
  if (
    !args.primaryTabId ||
    !args.startupPlan ||
    args.draftLaunchedNatively ||
    (args.promptDelivery === 'draft' && Boolean(args.startupPlan.draftPrompt))
  ) {
    return true
  }
  void pasteDirectWorkItemDraftWhenAgentReady({
    primaryTabId: args.primaryTabId,
    startupPlan: args.startupPlan,
    content: args.draftContent,
    ...(args.promptDelivery === 'submit-after-ready' ? { submit: true, forcePaste: true } : {})
  })
  return true
}
