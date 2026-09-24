import { useMemo } from 'react'
import {
  agentChildRowContextForParent,
  type AgentChildRowContext
} from '../../../../shared/agent-child-row-model'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { useNow } from '@/hooks/use-now'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { useAppStore } from '@/store'

/** The verdict a session's status row gives its children, exactly as the sidebar derives it. */
export function structuredSessionChildRowContext(
  parent: AgentStatusEntry,
  now: number
): AgentChildRowContext {
  return agentChildRowContextForParent(
    parent,
    isExplicitAgentStatusFresh(parent, now, AGENT_STATUS_STALE_AFTER_MS)
  )
}

/** The strip's children read their parent's verdict from the same status row the sidebar reads,
 *  so one child never says "No update" in one place and "Working" in the other. */
export function useStructuredSessionChildRowContext(
  paneKey: string
): AgentChildRowContext | undefined {
  const parent = useAppStore((state) => state.agentStatusByPaneKey[paneKey])
  // The freshness window is thirty minutes; a coarse shared tick is well inside its precision.
  const now = useNow(30_000, parent !== undefined)
  return useMemo(
    () => (parent ? structuredSessionChildRowContext(parent, now) : undefined),
    [parent, now]
  )
}
