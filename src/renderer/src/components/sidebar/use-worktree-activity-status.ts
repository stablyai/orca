import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './WorktreeCardHelpers'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'

export function useWorktreeActivityStatus(worktreeId: string): WorktreeStatus {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const browserTabs = useAppStore((s) => s.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS)
  const runtimePaneTitlesForWorktree = useAppStore(
    useShallow((s) => selectRuntimePaneTitlesForWorktree(s, worktreeId))
  )
  const ptyIdsForWorktree = useAppStore(
    useShallow((s) => selectLivePtyIdsForWorktree(s, worktreeId))
  )
  const { hasPermission, hasLiveDone, hasRetainedDone } = useAppStore(
    useShallow((s) => {
      // Touch the epoch so this selector re-runs when a fresh hook entry
      // crosses the stale boundary.
      void s.agentStatusEpoch
      const wtTabs = s.tabsByWorktree[worktreeId] ?? EMPTY_TABS
      let perm = false
      let live = false
      if (wtTabs.length > 0) {
        const tabIds = new Set(wtTabs.map((tab) => tab.id))
        const now = Date.now()
        for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
          const sepIdx = paneKey.indexOf(':')
          if (sepIdx <= 0) {
            continue
          }
          const tabId = paneKey.slice(0, sepIdx)
          if (!tabIds.has(tabId)) {
            continue
          }
          if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
            continue
          }
          if (entry.state === 'blocked' || entry.state === 'waiting') {
            perm = true
          } else if (entry.state === 'done') {
            live = true
          }
        }
      }

      let retained = false
      for (const agent of Object.values(s.retainedAgentsByPaneKey)) {
        if (agent.worktreeId === worktreeId) {
          retained = true
          break
        }
      }
      return { hasPermission: perm, hasLiveDone: live, hasRetainedDone: retained }
    })
  )

  // Why: compact and detailed cards need the same status-dot semantics:
  // runtime liveness gates title-derived states, then explicit agent rows can
  // promote permission/done so the dot matches visible agent state.
  return useMemo(
    () =>
      resolveWorktreeStatus({
        tabs,
        browserTabs,
        ptyIdsByTabId: ptyIdsForWorktree,
        runtimePaneTitlesByTabId: runtimePaneTitlesForWorktree,
        hasPermission,
        hasLiveDone,
        hasRetainedDone
      }),
    [
      tabs,
      browserTabs,
      ptyIdsForWorktree,
      runtimePaneTitlesForWorktree,
      hasPermission,
      hasLiveDone,
      hasRetainedDone
    ]
  )
}
