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
import { usePaneForegroundAgentEvidenceExpiryTick } from './use-pane-foreground-agent-evidence-expiry'

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
  const {
    hasPermission,
    hasLiveWorking,
    hasLiveDone,
    hasRetainedDone,
    agentStatusPaneIdsByTabId,
    paneForegroundAgentByPaneKey
  } = useAppStore(useShallow((s) => selectWorktreeAgentActivitySummary(s, worktreeId)))
  // Why: evidence decays by wall clock, so recompute at expiry even without a store write.
  const evidenceExpiryTick = usePaneForegroundAgentEvidenceExpiryTick(paneForegroundAgentByPaneKey)

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
        agentStatusPaneIdsByTabId,
        terminalLayoutRootsByTabId,
        paneForegroundAgentByPaneKey,
        hasPermission,
        hasLiveWorking,
        hasLiveDone,
        hasRetainedDone
      }),
    // Why: the tick forces resolveWorktreeStatus to re-read time at expiry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      evidenceExpiryTick,
      tabs,
      browserTabs,
      ptyIdsForWorktree,
      runtimePaneTitlesForWorktree,
      agentStatusPaneIdsByTabId,
      terminalLayoutRootsByTabId,
      paneForegroundAgentByPaneKey,
      hasPermission,
      hasLiveWorking,
      hasLiveDone,
      hasRetainedDone
    ]
  )
}
