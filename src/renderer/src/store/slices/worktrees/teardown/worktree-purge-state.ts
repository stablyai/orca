import type { AppState } from '../../../types'
import { forgetCombinedDiffViewsForWorktrees } from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'
import type { WorktreePurgeTarget, WorktreePurgeTargets } from '../../worktree-helpers'
import { forgetHugeRepoWarningDismissalsForWorktrees } from '@/lib/source-control-huge-repo-warning-dismissals'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { pruneHostedReviewLinkMutationGenerations } from '../metadata/hosted-review-link-mutation'
import { collectWorktreePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { createWorktreePurgeOmitters } from './worktree-purge-omitters'
import { omitSleepingAgentSessionsForWorktrees } from './sleeping-agent-session-omission'
import { removeDeleteStatesForWorktreeIds } from './worktree-delete-state'
import { omitRecordKeys } from './record-key-omission'
import { removeWorktreeVisitEntriesForTargets } from '@/lib/worktree-visit-recency'
import { forgetAmbiguousOwnerWarnings } from '@/lib/ambiguous-owner-warning'
import { forgetWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { removeWorktreeLayout } from '../../tabs/worktree-layout-lifecycle'
import {
  cancelStructuredLaunchesForWorktrees,
  retirePurgedTabLaunches
} from './purged-structured-launch-retirement'
import { buildWorktreePurgeSurfacePatch } from './worktree-purge-surface-patch'
import { noticeRemovedUnsavedFiles } from './removed-workspace-unsaved-files'
import { mergeEditorBufferKeepRequests } from '../../editor/buffers/editor-buffer-kept'
import { buildHostTwinPurgeState, collectHostTwinPurgeScopes } from './host-twin-worktree-purge'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

/**
 * Builds a bulk cleanup patch and clears auxiliary warning records without requiring individual
 * terminal teardown. A host target whose id another host still publishes purges only that host's
 * attributable state; everything else purges every bucket under the id.
 */
export function buildWorktreePurgeState(
  s: AppState,
  worktreeTargets: WorktreePurgeTargets,
  changedPaneKeys?: Set<string>
): Partial<AppState> {
  const targets: WorktreePurgeTarget[] = worktreeTargets.map((target) =>
    typeof target === 'string' ? { id: target } : target
  )
  const twinScopes = collectHostTwinPurgeScopes(s, targets)
  if (twinScopes.size === 0) {
    return buildFullWorktreePurgeState(s, targets, changedPaneKeys)
  }
  const twinIds = new Set([...twinScopes.values()].flatMap((twins) => [...twins.keys()]))
  const fullTargets = targets.filter((target) => !target.hostId || !twinIds.has(target.id))
  let patch =
    fullTargets.length > 0 ? buildFullWorktreePurgeState(s, fullTargets, changedPaneKeys) : {}
  for (const [hostId, twinHostIds] of twinScopes) {
    const twinPatch = buildHostTwinPurgeState(
      { ...s, ...patch },
      hostId,
      twinHostIds,
      changedPaneKeys
    )
    patch = {
      ...patch,
      ...twinPatch,
      editorBufferKeepRequest: mergeEditorBufferKeepRequests(
        patch.editorBufferKeepRequest,
        twinPatch.editorBufferKeepRequest
      )
    }
  }
  // Why both hosts: a paired runtime's copy writes recency and delete state under either identity.
  const hostKeys = [
    ...targets.flatMap((target) =>
      target.hostId && twinIds.has(target.id) ? [{ id: target.id, hostId: target.hostId }] : []
    ),
    ...[...twinScopes].flatMap(([hostId, twins]) => [...twins.keys()].map((id) => ({ id, hostId })))
  ]
  const next = { ...s, ...patch }
  return {
    ...patch,
    lastVisitedAtByWorktreeId: removeWorktreeVisitEntriesForTargets(
      next.lastVisitedAtByWorktreeId,
      hostKeys
    ),
    deleteStateByWorktreeId: omitRecordKeys(
      next.deleteStateByWorktreeId,
      hostKeys.map((target) => composeWorktreeHostIdentity(target.hostId, target.id))
    )
  }
}

/** Drops every bucket under the targets' ids; visit recency alone stays host-scoped. */
export function buildFullWorktreePurgeState(
  s: AppState,
  normalizedTargets: readonly WorktreePurgeTarget[],
  changedPaneKeys?: Set<string>
): Partial<AppState> {
  const worktreeIdSet = new Set(normalizedTargets.map((target) => target.id))
  forgetCombinedDiffViewsForWorktrees(worktreeIdSet)
  // Why: bulk purges bypass close actions, so provisional ownership must die before tab state does.
  const cancelledSessionIds = cancelStructuredLaunchesForWorktrees(worktreeIdSet)
  for (const worktreeId of worktreeIdSet) {
    retirePurgedTabLaunches(
      s,
      worktreeId,
      s.tabsByWorktree[worktreeId] ?? [],
      s.unifiedTabsByWorktree[worktreeId] ?? [],
      cancelledSessionIds
    )
  }
  pruneHostedReviewLinkMutationGenerations(worktreeIdSet)
  // Why: ids are repo::path, so a worktree recreated at the same path must not inherit a stale sleep.
  for (const id of worktreeIdSet) {
    forgetWorktreeSleepIntent(id)
  }
  // Why: every authoritative and explicit purge converges here, so a deleted path can't inherit stale UI state.
  forgetHugeRepoWarningDismissalsForWorktrees(worktreeIdSet)
  forgetAmbiguousOwnerWarnings(worktreeIdSet)

  const doomed = collectWorktreePurgeDoomedIds(s, worktreeIdSet)
  const editorBufferKeepRequest = noticeRemovedUnsavedFiles(s, doomed.removedFileIds)
  const omitters = createWorktreePurgeOmitters(s, worktreeIdSet, doomed)
  const {
    omitByWorktree,
    omitWorkspaceLineageByWorktree,
    pruneRightSidebarTabByWorktree,
    omitByPaneKeyTabPrefix
  } = omitters

  const removedActive = s.activeWorktreeId != null && worktreeIdSet.has(s.activeWorktreeId)
  const activeFileCleared = s.activeFileId != null && doomed.removedFileIds.has(s.activeFileId)

  const nextEverActivatedWorktreeIds = (() => {
    let hit = false
    for (const id of worktreeIdSet) {
      if (s.everActivatedWorktreeIds.has(id)) {
        hit = true
        break
      }
    }
    if (!hit) {
      return s.everActivatedWorktreeIds
    }
    const next = new Set(s.everActivatedWorktreeIds)
    for (const id of worktreeIdSet) {
      next.delete(id)
    }
    return next
  })()
  const tabPrefixedSleeping = {
    sleepingAgentSessionsByPaneKey: omitByPaneKeyTabPrefix(s.sleepingAgentSessionsByPaneKey),
    agentLaunchConfigByPaneKey: omitByPaneKeyTabPrefix(s.agentLaunchConfigByPaneKey)
  }
  // Why both: tab-prefix omission misses a sleeping record whose tab is already gone.
  const nextSleeping = {
    ...tabPrefixedSleeping,
    ...omitSleepingAgentSessionsForWorktrees(tabPrefixedSleeping, worktreeIdSet)
  }

  return {
    editorBufferKeepRequest,
    ...removeWorktreeLayout(s, {
      worktreeIds: worktreeIdSet,
      tabIds: doomed.doomedTabIds,
      activeFileCleared
    }),
    ...buildWorktreePurgeSurfacePatch(
      s,
      omitters,
      doomed.doomedTabIds,
      nextSleeping,
      changedPaneKeys
    ),
    worktreeLineageById: omitByWorktree(s.worktreeLineageById),
    workspaceLineageByChildKey: omitWorkspaceLineageByWorktree(s.workspaceLineageByChildKey),
    deleteStateByWorktreeId: removeDeleteStatesForWorktreeIds(
      s.deleteStateByWorktreeId,
      worktreeIdSet
    ),
    baseStatusByWorktreeId: omitByWorktree(s.baseStatusByWorktreeId),
    remoteBranchConflictByWorktreeId: omitByWorktree(s.remoteBranchConflictByWorktreeId),
    fileSearchStateByWorktree: omitByWorktree(s.fileSearchStateByWorktree),
    recentlyClosedBrowserTabsByWorktree: omitByWorktree(s.recentlyClosedBrowserTabsByWorktree),
    pendingReconnectTabByWorktree: omitByWorktree(s.pendingReconnectTabByWorktree),
    rightSidebarTabByWorktree: pruneRightSidebarTabByWorktree(),
    rightSidebarExplorerViewByWorktree: omitByWorktree(s.rightSidebarExplorerViewByWorktree ?? {}),
    gitStatusByWorktree: omitByWorktree(s.gitStatusByWorktree),
    remoteStatusesByWorktree: omitByWorktree(s.remoteStatusesByWorktree),
    gitStatusHeadByWorktree: omitByWorktree(s.gitStatusHeadByWorktree),
    gitBranchLineTotalByWorktree: omitByWorktree(s.gitBranchLineTotalByWorktree),
    gitIgnoredPathsByWorktree: omitByWorktree(s.gitIgnoredPathsByWorktree),
    gitConflictOperationByWorktree: omitByWorktree(s.gitConflictOperationByWorktree),
    trackedConflictPathsByWorktree: omitByWorktree(s.trackedConflictPathsByWorktree),
    gitBranchChangesByWorktree: omitByWorktree(s.gitBranchChangesByWorktree),
    gitBranchCompareSummaryByWorktree: omitByWorktree(s.gitBranchCompareSummaryByWorktree),
    gitBranchCompareRequestKeyByWorktree: omitByWorktree(s.gitBranchCompareRequestKeyByWorktree),
    gitBranchCompareRequestStatusHeadByWorktree: omitByWorktree(
      s.gitBranchCompareRequestStatusHeadByWorktree
    ),
    gitStatusHugeByWorktree: omitByWorktree(s.gitStatusHugeByWorktree),
    gitStatusReadErrorByWorktree: omitByWorktree(s.gitStatusReadErrorByWorktree),
    explorerDisplayRootByWorktree: omitByWorktree(s.explorerDisplayRootByWorktree),
    showDotfilesByWorktree: omitByWorktree(s.showDotfilesByWorktree),
    expandedDirs: omitByWorktree(s.expandedDirs),
    recentlyClosedEditorTabsByWorktree: omitByWorktree(s.recentlyClosedEditorTabsByWorktree),
    recentlyClosedTerminalTabsByWorktree: omitByWorktree(s.recentlyClosedTerminalTabsByWorktree),
    recentlyClosedTabKindsByWorktree: omitByWorktree(s.recentlyClosedTabKindsByWorktree),
    everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
    lastVisitedAtByWorktreeId: removeWorktreeVisitEntriesForTargets(
      s.lastVisitedAtByWorktreeId,
      normalizedTargets
    ),
    defaultTerminalTabsAppliedByWorktreeId: omitByWorktree(
      s.defaultTerminalTabsAppliedByWorktreeId
    ),
    activeWorktreeId: removedActive ? null : s.activeWorktreeId,
    activeWorkspaceExecutionHostId: removedActive ? null : s.activeWorkspaceExecutionHostId,
    activeWorkspaceKey: (() => {
      if (s.activeWorkspaceKey && worktreeIdSet.has(s.activeWorkspaceKey)) {
        return null
      }
      const activeScope = s.activeWorkspaceKey ? parseWorkspaceKey(s.activeWorkspaceKey) : null
      return activeScope?.type === 'worktree' && worktreeIdSet.has(activeScope.worktreeId)
        ? null
        : s.activeWorkspaceKey
    })()
  }
}
