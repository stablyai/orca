import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'

type ActivityUnreadCountSource = Pick<
  AppState,
  | 'acknowledgedAgentsByPaneKey'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'worktreesByRepo'
>

type ActivityUnreadCountMode = 'agent-events' | 'agent-threads' | 'sidebar-badge'

const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}
const EMPTY_MIGRATION_UNSUPPORTED: AppState['migrationUnsupportedByPtyId'] = {}
const EMPTY_RETAINED_AGENTS: AppState['retainedAgentsByPaneKey'] = {}
const EMPTY_ACKNOWLEDGED_AGENTS: AppState['acknowledgedAgentsByPaneKey'] = {}

const DISABLED_ACTIVITY_UNREAD_INPUTS = {
  sortEpoch: 0,
  worktreesByRepo: EMPTY_WORKTREES_BY_REPO,
  migrationUnsupportedByPtyId: EMPTY_MIGRATION_UNSUPPORTED,
  retainedAgentsByPaneKey: EMPTY_RETAINED_AGENTS,
  acknowledgedAgentsByPaneKey: EMPTY_ACKNOWLEDGED_AGENTS
}

function isUnreadAgentState(state: AgentStatusState): boolean {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}

export function countActivityUnread(
  source: ActivityUnreadCountSource,
  mode: ActivityUnreadCountMode
): number {
  let count = 0
  const unreadAgentPaneKeys = mode === 'agent-threads' ? new Set<string>() : null

  if (mode === 'sidebar-badge') {
    for (const worktrees of Object.values(source.worktreesByRepo)) {
      for (const worktree of worktrees) {
        if (worktree.createdAt && worktree.isUnread) {
          count += 1
        }
      }
    }
  }

  const countEntry = (paneKey: string, entry: AgentStatusEntry, ackAt: number): void => {
    let hasUnreadAgentEvent = false
    if (mode !== 'sidebar-badge') {
      // Why: titlebar counts events, while thread badges collapse attention history by pane.
      for (const history of entry.stateHistory) {
        if (isUnreadAgentState(history.state) && ackAt < history.startedAt) {
          if (mode === 'agent-events') {
            count += 1
          } else {
            hasUnreadAgentEvent = true
          }
        }
      }
    }
    if (isUnreadAgentState(entry.state) && ackAt < entry.stateStartedAt) {
      if (mode === 'agent-threads') {
        hasUnreadAgentEvent = true
      } else {
        count += 1
      }
    }
    if (hasUnreadAgentEvent) {
      unreadAgentPaneKeys?.add(paneKey)
    }
  }

  for (const [paneKey, entry] of Object.entries(source.agentStatusByPaneKey)) {
    countEntry(paneKey, entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
  }
  for (const [paneKey, retained] of Object.entries(source.retainedAgentsByPaneKey)) {
    if (mode === 'sidebar-badge' && retained.entry.state !== 'done') {
      continue
    }
    countEntry(paneKey, retained.entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
  }
  for (const unsupported of Object.values(source.migrationUnsupportedByPtyId)) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    if (entry) {
      countEntry(entry.paneKey, entry, source.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0)
    }
  }

  return unreadAgentPaneKeys?.size ?? count
}

export function useActivityUnreadCount(enabled: boolean, mode: ActivityUnreadCountMode): number {
  const {
    sortEpoch,
    worktreesByRepo,
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
        worktreesByRepo: state.worktreesByRepo,
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
    return countActivityUnread(
      {
        agentStatusByPaneKey: useAppStore.getState().agentStatusByPaneKey,
        migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey,
        worktreesByRepo,
        acknowledgedAgentsByPaneKey
      },
      mode
    )
  }, [
    acknowledgedAgentsByPaneKey,
    enabled,
    migrationUnsupportedByPtyId,
    mode,
    retainedAgentsByPaneKey,
    sortEpoch,
    worktreesByRepo
  ])
}
