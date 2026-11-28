import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { AgentStatusOrchestrationContext } from '../../agent-status/contracts/agent-status-types'

// Bounded like a worktree.ps page of agent rows; pane keys are `${tabId}:${leafUuid}`.
const AgentActivityPaneKeys = lazyZodSchema(() =>
  z.array(z.string().min(1).max(512)).min(1).max(500)
)

export const AgentActivitySetReadParams = lazyZodSchema(() =>
  z.object({
    paneKeys: AgentActivityPaneKeys,
    read: z.boolean(),
    /** When set on a read, ignore panes whose latest turn is newer than what the client displayed. */
    upToTimestamp: z.number().finite().positive().optional()
  })
)

export const AgentActivityClearParams = lazyZodSchema(() =>
  z.object({ paneKeys: AgentActivityPaneKeys })
)

/** The host's Dispatch context for each agent row it runs, keyed by the host's pane keys. */
export const AGENT_ACTIVITY_ORCHESTRATION_METHOD = 'agentActivity.orchestration'

export const AgentActivityOrchestrationParams = lazyZodSchema(() =>
  z.object({
    sinceRevision: z.number().int().nonnegative().optional()
  })
)

export type AgentActivityOrchestrationResult =
  | {
      contexts: Record<string, AgentStatusOrchestrationContext>
      revision?: number
      unchanged?: false
    }
  | {
      revision: number
      unchanged: true
    }

/** Bounds one reply; a host past it sends its first contexts, and a reader ignores the rest. */
export const AGENT_ACTIVITY_ORCHESTRATION_MAX_CONTEXTS = 2_000
