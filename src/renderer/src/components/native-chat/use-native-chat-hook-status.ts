import { useAppStore } from '../../store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState
} from '../../../../shared/agent-status-types'

/** Restored nonterminal rows need a live hook confirmation before they may keep chat busy. */
export function resolveNativeChatHookState(
  entry:
    | Pick<AgentStatusEntry, 'state' | 'workingMode' | 'updatedAt' | 'restoredUnconfirmed'>
    | undefined,
  now = Date.now()
): AgentStatusState | null {
  if (!entry || !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
    return null
  }
  return entry.state === 'working' && entry.workingMode === 'monitoring' ? null : entry.state
}

export function useNativeChatHookStatus(
  paneKey: string
): readonly [AgentStatusState | null, number | null, boolean] {
  // Subscribe to TTL expiry so silent working rows eventually stop keeping chat busy.
  const agentStatusEpoch = useAppStore((store) => store.agentStatusEpoch)
  void agentStatusEpoch
  // Primitive selectors avoid rerenders for unrelated status changes.
  const state = useAppStore((store) => {
    const entry = store.agentStatusByPaneKey[paneKey]
    return resolveNativeChatHookState(entry)
  })
  const stateStartedAt = useAppStore(
    (store) => store.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null
  )
  // Only children started in this parent epoch may delay settlement; missed stops and reused panes leave stale roster entries.
  const hasWorkingSubagents = useAppStore((store) => {
    const entry = store.agentStatusByPaneKey[paneKey]
    const epochStart = entry?.stateStartedAt
    return (
      entry?.subagents?.some(
        (subagent) =>
          subagent.state === 'working' && (epochStart == null || subagent.startedAt >= epochStart)
      ) ?? false
    )
  })
  return [state, stateStartedAt, hasWorkingSubagents]
}
