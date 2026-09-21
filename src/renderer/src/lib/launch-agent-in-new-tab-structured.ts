import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'

export type StructuredNewTabLaunchArgs = {
  /** Planned on the structured route with an already-trimmed prompt; empty means no prompt. */
  plan: AgentSessionLaunchPlan
  targetGroupId?: string
  activate?: boolean
  /** Lets a workspace reveal itself after ID allocation but before tab ownership. */
  beforeOpen?: (sessionId: string) => boolean | void
}

export type StructuredNewTabLaunch = {
  sessionId: string
  tabId: string
  structuredSettlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

/**
 * The new-tab launcher's structured branch. Returns synchronously so `launchAgentInNewTab` keeps
 * its signature; the settlement carries what the structured launch actually did.
 */
export function launchAgentInStructuredNewTab(
  args: StructuredNewTabLaunchArgs
): StructuredNewTabLaunch | null {
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan: args.plan,
    hooks: {},
    ...(args.activate !== undefined ? { activate: args.activate } : {}),
    ...(args.beforeOpen ? { beforeOpen: args.beforeOpen } : {}),
    ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {})
  })
  if (!launch) {
    return null
  }
  const structuredSettlement = launch.settlement
  void structuredSettlement.then((settlement) => {
    if (settlement.kind === 'failed') {
      console.error('Structured agent launch failed', settlement.error)
    }
  })
  return {
    sessionId: launch.sessionId,
    tabId: launch.tab.id,
    structuredSettlement,
    // Why: draft mode has no delivery event; the composer owns the text until the user sends it.
    ...(launch.promptDeliveryResult && args.plan.promptDelivery !== 'draft'
      ? { promptDeliveryResult: launch.promptDeliveryResult }
      : {})
  }
}
