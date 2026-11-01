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

/** Use the sidebar’s parent verdict so the same child cannot disagree between strip and sidebar. */
export function useStructuredSessionChildRowContext(
  paneKey: string
): AgentChildRowContext | undefined {
  const parent = useAppStore((state) => state.agentStatusByPaneKey[paneKey])
  // The freshness window is thirty minutes; a coarse shared tick is well inside its precision.
  const now = useNow(30_000, parent !== undefined)
  const context = parent ? structuredSessionChildRowContext(parent, now) : undefined
  // Memoize by verdict fields so unchanged status updates cannot rebuild grouped child rows.
  const fresh = context?.parentEvidenceFresh
  const observation = context?.transportObservation
  const observedAt = context?.parentObservedAt
  const offset = context?.hostClockOffsetMs
  return useMemo(
    () =>
      fresh === undefined ||
      observation === undefined ||
      observedAt === undefined ||
      offset === undefined
        ? undefined
        : {
            parentEvidenceFresh: fresh,
            transportObservation: observation,
            parentObservedAt: observedAt,
            hostClockOffsetMs: offset
          },
    [fresh, observation, observedAt, offset]
  )
}
