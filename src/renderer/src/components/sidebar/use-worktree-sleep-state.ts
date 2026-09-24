import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'

type TabLike = { id: string }

// Why optional: suites mount cards with partial store mocks, and the shared
// predicate already reads a missing slice as empty.
type SleepStateInput = {
  agentStatusByPaneKey?: Record<string, AgentStatusEntry> | null
  agentStatusEpoch?: number
  tabsByWorktree?: Record<string, readonly TabLike[]> | null
  ptyIdsByTabId?: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, readonly TabLike[]> | null
  unifiedTabsByWorktree?: Record<string, Tab[]> | null
}

type LiveAgentGeneration = {
  agentStatusByPaneKey: SleepStateInput['agentStatusByPaneKey']
  tabsByWorktree: SleepStateInput['tabsByWorktree']
  agentStatusNow: number
  worktreeIds: ReadonlySet<string>
}

let liveAgentGeneration: LiveAgentGeneration | null = null

// Why cached across cards: zustand re-runs every mounted card's selector on every
// store write, and the live-agent set is a whole-store scan. Keyed on the same
// slices plus the status epoch, so it rebuilds exactly when the filter's own
// snapshot would.
function selectWorktreeIdsWithLiveAgent(state: SleepStateInput): ReadonlySet<string> {
  const agentStatusNow = getAgentStatusEpochNow(state.agentStatusEpoch ?? 0)
  if (
    liveAgentGeneration &&
    liveAgentGeneration.agentStatusByPaneKey === state.agentStatusByPaneKey &&
    liveAgentGeneration.tabsByWorktree === state.tabsByWorktree &&
    liveAgentGeneration.agentStatusNow === agentStatusNow
  ) {
    return liveAgentGeneration.worktreeIds
  }
  const worktreeIds = getWorktreeIdsWithLiveAgent(
    state.agentStatusByPaneKey,
    state.tabsByWorktree,
    agentStatusNow
  )
  liveAgentGeneration = {
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    agentStatusNow,
    worktreeIds
  }
  return worktreeIds
}

/**
 * Whether a workspace is asleep: no live terminal, no browser tab, no live
 * agent holding it awake through a PTY gap, and no structured chat.
 *
 * Why not `status === 'inactive'`: a slept workspace keeps its retained done
 * rows, so its status still reads 'done' — keying the sleeping glyph on status
 * misses exactly the completed-but-slept cards it must distinguish (#19624).
 *
 * Why `isInactiveWorkspace`: the hide-sleeping filter decides with that same
 * predicate, so the moon and the filter cannot disagree about which workspaces
 * are asleep.
 */
export function useIsSleepingWorktree(worktreeId: string): boolean {
  return useAppStore((state) =>
    isInactiveWorkspace(
      worktreeId,
      state.tabsByWorktree,
      state.ptyIdsByTabId,
      state.browserTabsByWorktree,
      selectWorktreeIdsWithLiveAgent(state),
      getWorktreeIdsWithStructuredChat(state.unifiedTabsByWorktree)
    )
  )
}

export function resetWorktreeSleepStateCacheForTests(): void {
  liveAgentGeneration = null
}
