import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
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
  const { hasPermission, hasLiveWorking, hasLiveDone, hasRetainedDone } = useAppStore(
    useShallow((s) => {
      // Touch the epoch so this selector re-runs when a fresh hook entry
      // crosses the stale boundary.
      void s.agentStatusEpoch
      const wtTabs = s.tabsByWorktree[worktreeId] ?? EMPTY_TABS
      let perm = false
      let working = false
      let done = false
      if (wtTabs.length > 0) {
        const tabIds = new Set(wtTabs.map((tab) => tab.id))
        const now = Date.now()
        for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
          const parsed = parsePaneKey(paneKey)
          if (!parsed || !tabIds.has(parsed.tabId)) {
            continue
          }
          if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
            continue
          }
          if (entry.state === 'blocked' || entry.state === 'waiting') {
            perm = true
          } else if (entry.state === 'working') {
            working = true
          } else if (entry.state === 'done') {
            done = true
          }
        }
        for (const unsupported of Object.values(s.migrationUnsupportedByPtyId ?? {})) {
          const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
          if (!entry) {
            continue
          }
          const parsed = parsePaneKey(entry.paneKey)
          if (parsed && tabIds.has(parsed.tabId)) {
            perm = true
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
      return {
        hasPermission: perm,
        hasLiveWorking: working,
        hasLiveDone: done,
        hasRetainedDone: retained
      }
    })
  )

  // Why: compact and detailed cards need the same status-dot semantics:
  // runtime liveness gates title-derived states, then explicit agent rows can
  // promote working/permission/done so the dot matches visible agent state.
  return useMemo(
    () =>
      resolveWorktreeStatus({
        tabs,
        browserTabs,
        ptyIdsByTabId: ptyIdsForWorktree,
        runtimePaneTitlesByTabId: runtimePaneTitlesForWorktree,
        hasPermission,
        hasLiveWorking,
        hasLiveDone,
        hasRetainedDone
      }),
    [
      tabs,
      browserTabs,
      ptyIdsForWorktree,
      runtimePaneTitlesForWorktree,
      hasPermission,
      hasLiveWorking,
      hasLiveDone,
      hasRetainedDone
    ]
  )
}
