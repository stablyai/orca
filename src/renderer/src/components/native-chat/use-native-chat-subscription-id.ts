import { useMemo } from 'react'
import { resolveNativeChatTransport } from '../../../../shared/native-chat-agent-support'
import type { AgentType } from '../../../../shared/native-chat-types'

export type NativeChatSubscriptionIds = {
  /** Id this pane subscribes under, for any transport. */
  subscriptionId: string
  /** The same id when the pane is ACP-backed, else null — the flag the view and
   *  composer use to route prompts and approvals to the agent instead of a PTY. */
  acpSubscriptionId: string | null
}

/**
 * Mint a stable subscription id for a pane's native chat session.
 *
 * Lives in the view rather than inside useNativeChatLiveSession because the ACP
 * transport addresses prompts and tool approvals by subscription id, so the
 * caller has to know the id it is subscribing under. Re-minted when the pane
 * changes so a new pane never inherits another's channel.
 */
export function useNativeChatSubscriptionId(
  paneKey: string,
  agent: AgentType
): NativeChatSubscriptionIds {
  return useMemo(() => {
    const subscriptionId = `nc-${paneKey}-${Math.random().toString(36).slice(2, 10)}`
    return {
      subscriptionId,
      acpSubscriptionId: resolveNativeChatTransport(agent) === 'acp' ? subscriptionId : null
    }
  }, [paneKey, agent])
}
