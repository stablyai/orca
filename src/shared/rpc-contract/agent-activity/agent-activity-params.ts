import { z } from 'zod'
import type { AgentStatusOrchestrationContext } from '../../agent-status/contracts/agent-status-types'

// Bounded like a worktree.ps page of agent rows; pane keys are `${tabId}:${leafUuid}`.
const AgentActivityPaneKeys = z.array(z.string().min(1).max(512)).min(1).max(500)

export const AgentActivitySetReadParams = z.object({
  paneKeys: AgentActivityPaneKeys,
  read: z.boolean()
})

export const AgentActivityClearParams = z.object({ paneKeys: AgentActivityPaneKeys })

/** The host's Dispatch context for each agent row it runs, keyed by the host's pane keys. */
export const AGENT_ACTIVITY_ORCHESTRATION_METHOD = 'agentActivity.orchestration'

export type AgentActivityOrchestrationResult = {
  contexts: Record<string, AgentStatusOrchestrationContext>
}
