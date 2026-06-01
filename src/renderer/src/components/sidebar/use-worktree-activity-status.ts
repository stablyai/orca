import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './WorktreeCardHelpers'
import {
  selectLivePtyIdsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'

export function useWorktreeActivityStatus(worktreeId: string): WorktreeStatus {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const browserTabs = useAppStore((s) => s.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS)
  const runtimePaneTitlesForWorktree = useAppStore(
    useShallow((s) => selectRuntimePaneTitlesForWorktree(s, worktreeId))
  )
  const ptyIdsForWorktree = useAppStore(
    useShallow((s) => selectLivePtyIdsForWorktree(s, worktreeId))
  )
  const terminalLayoutRootsByTabId = useAppStore(
    useShallow((s) => selectTerminalLayoutRootsForWorktree(s, worktreeId))
  )
  const { hasPermission, hasLiveWorking, hasLiveDone, hasRetainedDone, freshHookLeafIdsByTabId } =
    useAppStore(useShallow((s) => selectWorktreeAgentActivitySummary(s, worktreeId)))

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
        freshHookLeafIdsByTabId,
        terminalLayoutRootsByTabId,
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
      freshHookLeafIdsByTabId,
      terminalLayoutRootsByTabId,
      hasPermission,
      hasLiveWorking,
      hasLiveDone,
      hasRetainedDone
    ]
  )
}
