import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../shared/tui-agent'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { pasteDirectWorkItemDraftWhenAgentReady } from '@/lib/launch-work-item-direct-agent'

export function deliverDirectWorkItemPrompt(args: {
  primaryTabId: string | null
  effectiveAgent: TuiAgent | null
  draftContent: string
  promptDelivery: 'draft' | 'submit-after-ready'
  startupPlan: AgentStartupPlan | null
  draftLaunchedNatively: boolean
}): void {
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
    return
  }
  void pasteDirectWorkItemDraftWhenAgentReady({
    primaryTabId: args.primaryTabId,
    startupPlan: args.startupPlan,
    content: args.draftContent,
    submit: args.promptDelivery === 'submit-after-ready',
    forcePaste: args.promptDelivery === 'submit-after-ready'
  })
}
