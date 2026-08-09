import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { countUnreadAgentPaneThreads } from './agent-pane-threads'

const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_WORKTREE_MAP: ReturnType<typeof getWorktreeMapFromState> = new Map()
const EMPTY_REPO_MAP: ReturnType<typeof getRepoMapFromState> = new Map()
const EMPTY_MIGRATION_UNSUPPORTED: AppState['migrationUnsupportedByPtyId'] = {}
const EMPTY_RETAINED_AGENTS: AppState['retainedAgentsByPaneKey'] = {}
const EMPTY_ACKNOWLEDGED_AGENTS: AppState['acknowledgedAgentsByPaneKey'] = {}

const DISABLED_ACTIVITY_UNREAD_INPUTS = {
  sortEpoch: 0,
  tabsByWorktree: EMPTY_TABS_BY_WORKTREE,
  worktreeMap: EMPTY_WORKTREE_MAP,
  repoMap: EMPTY_REPO_MAP,
  migrationUnsupportedByPtyId: EMPTY_MIGRATION_UNSUPPORTED,
  retainedAgentsByPaneKey: EMPTY_RETAINED_AGENTS,
  acknowledgedAgentsByPaneKey: EMPTY_ACKNOWLEDGED_AGENTS
}

// Why: the sidebar pill and Agents titlebar badge must equal the unread rows the
// Agents page lists (and that "Mark all read" acknowledges), so the count derives
// from the same thread build instead of a parallel per-entry tally.
export function useActivityUnreadCount(enabled: boolean): number {
  const {
    sortEpoch,
    tabsByWorktree,
    worktreeMap,
    repoMap,
    migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey,
    acknowledgedAgentsByPaneKey
  } = useAppStore(
    useShallow((state) => {
      if (!enabled) {
        return DISABLED_ACTIVITY_UNREAD_INPUTS
      }
      return {
        // Why: live status prompt/tool updates churn agentStatusByPaneKey but
        // cannot change unread count unless a sort-relevant state transition
        // or removal occurred. sortEpoch is the cheap invalidation signal.
        sortEpoch: state.sortEpoch,
        tabsByWorktree: state.tabsByWorktree,
        worktreeMap: getWorktreeMapFromState(state),
        repoMap: getRepoMapFromState(state),
        migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
        acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey
      }
    })
  )

  return useMemo(() => {
    if (!enabled) {
      return 0
    }
    void sortEpoch
    return countUnreadAgentPaneThreads({
      agentStatusByPaneKey: useAppStore.getState().agentStatusByPaneKey,
      migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey,
      tabsByWorktree,
      worktreeMap,
      repoMap,
      acknowledgedAgentsByPaneKey,
      now: Date.now()
    })
  }, [
    acknowledgedAgentsByPaneKey,
    enabled,
    migrationUnsupportedByPtyId,
    repoMap,
    retainedAgentsByPaneKey,
    sortEpoch,
    tabsByWorktree,
    worktreeMap
  ])
}
