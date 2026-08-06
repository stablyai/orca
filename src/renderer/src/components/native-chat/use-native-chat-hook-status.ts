import { useAppStore } from '../../store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

export function useNativeChatHookStatus(
  paneKey: string
): readonly [AgentStatusState | null, number | null, boolean] {
  // Why: primitive selectors keep unrelated pane/status updates from rerendering
  // native chat while still exposing the three fields used for reconciliation.
  const state = useAppStore((store) => store.agentStatusByPaneKey[paneKey]?.state ?? null)
  const stateStartedAt = useAppStore(
    (store) => store.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null
  )
  // Why: only children that started during the current parent working epoch can
  // keep the session working after lead completion. Prior-turn roster leftovers
  // (missed SubagentStop, pane reuse) must not veto settle forever.
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
