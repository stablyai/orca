import { useMemo } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { resolveRepoWorktreeLaunchPlatform } from '@/lib/execution-host-facts'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import { nestedStatusKey } from '@/lib/nested-status-key'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById, useWorktreeMap } from '@/store/selectors'
import { getGitHubPRCacheKey } from '../../../../../../shared/github/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { selectReviewCacheData, selectReviewCacheEntry } from '../../review-cache-entry-selection'

const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntry[] = []
const EMPTY_BRANCH_CHANGE_ENTRIES: GitBranchChangeEntry[] = []

/**
 * Resolves the active worktree/repo and every store-backed value the Source Control panel reads
 * about it: git status, branch compare, conflict + upstream state, hosted-review cache entries and
 * the repo-owner-routed settings that every git call must be pinned to.
 */
export function useSourceControlWorktreeContext(nestedRepoPath?: string) {
  const workspaceWorktree = useActiveWorktree()
  const activeWorktree = useMemo(
    () =>
      nestedRepoPath && workspaceWorktree
        ? {
            ...workspaceWorktree,
            linkedPR: null,
            linkedGitLabMR: null,
            linkedBitbucketPR: null,
            linkedAzureDevOpsPR: null,
            linkedGiteaPR: null,
            suppressedGitHubPR: undefined,
            pushTarget: undefined
          }
        : workspaceWorktree,
    [nestedRepoPath, workspaceWorktree]
  )
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktreeInstanceId = activeWorktree?.instanceId
  const activeGroupId = useAppStore((s) =>
    activeWorktreeId ? s.activeGroupIdByWorktree[activeWorktreeId] : undefined
  )
  const worktreeMap = useWorktreeMap()
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeRepoId = activeRepo?.id ?? null
  const activeRepoPath = activeRepo?.path ?? null
  const activeRepoConnectionId = activeRepo?.connectionId ?? null
  const activeRepoExecutionHostId = activeRepo?.executionHostId ?? null
  const gitIdentityDisplay = activeWorktree ? getWorktreeGitIdentityDisplay(activeWorktree) : null
  const branchName = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const entries = useAppStore((s) =>
    activeWorktreeId
      ? (s.gitStatusByWorktree[activeWorktreeId] ?? EMPTY_GIT_STATUS_ENTRIES)
      : EMPTY_GIT_STATUS_ENTRIES
  )
  const activeGitStatusHead = useAppStore((s) =>
    activeWorktreeId ? (s.gitStatusHeadByWorktree?.[activeWorktreeId] ?? null) : null
  )
  const repositoryHuge = useAppStore((s) =>
    activeWorktreeId ? s.gitStatusHugeByWorktree?.[activeWorktreeId] : undefined
  )
  const branchEntries = useAppStore((s) =>
    activeWorktreeId
      ? (s.gitBranchChangesByWorktree[activeWorktreeId] ?? EMPTY_BRANCH_CHANGE_ENTRIES)
      : EMPTY_BRANCH_CHANGE_ENTRIES
  )
  const branchSummary = useAppStore((s) =>
    activeWorktreeId ? (s.gitBranchCompareSummaryByWorktree[activeWorktreeId] ?? null) : null
  )
  const publishedBranchLineTotal = useAppStore((s) =>
    activeWorktreeId ? (s.gitBranchLineTotalByWorktree?.[activeWorktreeId] ?? null) : null
  )
  // Why: status and branch compare refresh on different cadences, so a total can
  // outlive the fork point it measured. Drop it rather than render a stale number.
  const branchLineTotal =
    publishedBranchLineTotal && publishedBranchLineTotal.mergeBase === branchSummary?.mergeBase
      ? publishedBranchLineTotal
      : null
  const conflictOperation = useAppStore((s) =>
    activeWorktreeId ? (s.gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown') : 'unknown'
  )
  const conflictOperationsByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  // Why: leave undefined until fetchUpstreamStatus resolves; a synthetic "no upstream" flashes "Publish Branch" on worktree switch.
  // Nested repos get their own slot so their ahead/behind never overwrites the workspace's.
  const remoteStatusKey =
    nestedRepoPath && activeWorktreeId
      ? nestedStatusKey(activeWorktreeId, nestedRepoPath)
      : undefined
  const remoteStatus = useAppStore((s) =>
    activeWorktreeId ? s.remoteStatusesByWorktree[remoteStatusKey ?? activeWorktreeId] : undefined
  )
  const isRemoteOperationActive = useAppStore((s) => s.isRemoteOperationActive)
  const inFlightRemoteOpKind = useAppStore((s) => s.inFlightRemoteOpKind)
  const settings = useAppStore((s) => s.settings)
  // Review caches and links are keyed by the workspace repo + branch, so a nested repo must not read them.
  const hostedReviewCacheKey =
    activeRepo && branchName && !nestedRepoPath
      ? getHostedReviewCacheKey(
          activeRepo.path,
          branchName,
          settings,
          activeRepo.id,
          activeRepo.connectionId,
          activeRepo.executionHostId,
          true
        )
      : null
  const activePrCacheKey =
    activeRepo && branchName && !nestedRepoPath
      ? getGitHubPRCacheKey(
          activeRepo.path,
          activeRepo.id,
          branchName,
          settings,
          activeRepo.connectionId,
          activeRepo.executionHostId,
          true
        )
      : null
  // Why: background review refreshes replace both cache maps; this panel only needs its active repo/branch entries.
  const hostedReviewEntry = useAppStore((s) =>
    selectReviewCacheEntry(s.hostedReviewCache, hostedReviewCacheKey)
  )
  const hostedReviewEntryData = hostedReviewEntry?.data ?? null
  const activePrFromQueue = useAppStore((s) => selectReviewCacheData(s.prCache, activePrCacheKey))
  // Why: git calls and repo metadata go to the repo's OWNER host; `null` (no repo row) runs nothing.
  const activeRepoTarget = useMemo(
    () =>
      activeRepoId
        ? ipcOrRuntimeTargetForHostId(
            getRepoExecutionHostId({
              connectionId: activeRepoConnectionId,
              executionHostId: activeRepoExecutionHostId
            })
          )
        : null,
    [activeRepoConnectionId, activeRepoExecutionHostId, activeRepoId]
  )
  const activeRepoRuntimeEnvironmentId =
    activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)

  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false
  const worktreePath = activeWorktree?.path ?? null
  const activeConnectionId = activeWorktreeId
    ? (getConnectionId(activeWorktreeId) ?? activeRepoConnectionId)
    : null
  // Why: agents run on the workspace's execution host, so its OS decides quoting (#27971).
  const activeSourceControlLaunchPlatform =
    activeWorktree && activeRepo
      ? resolveRepoWorktreeLaunchPlatform(useAppStore.getState(), activeRepo, activeWorktree)
      : undefined
  // Why: the sidebar stays mounted when closed, so gate polling on tab AND open or branchCompare/PR fetch would run with no visible consumer.
  const isBranchVisible = rightSidebarTab === 'source-control' && rightSidebarOpen
  const hasUncommittedEntries = entries.length > 0

  return {
    activeConnectionId,
    activeGitStatusHead,
    activeGroupId,
    activePrCacheKey,
    activePrFromQueue,
    activeRepo,
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoPath,
    activeRepoRuntimeEnvironmentId,
    activeRepoTarget,
    activeSourceControlLaunchPlatform,
    activeWorktree,
    activeWorktreeId,
    activeWorktreeInstanceId,
    branchEntries,
    branchLineTotal,
    branchName,
    branchSummary,
    conflictOperation,
    conflictOperationsByWorktree,
    entries,
    gitIdentityDisplay,
    hasUncommittedEntries,
    hostedReviewCacheKey,
    hostedReviewEntry,
    hostedReviewEntryData,
    inFlightRemoteOpKind,
    isBranchVisible,
    isFolder,
    isRemoteOperationActive,
    remoteStatus,
    remoteStatusKey,
    repositoryHuge,
    rightSidebarTab,
    settings,
    worktreeMap,
    worktreePath
  }
}

export type SourceControlWorktreeContext = ReturnType<typeof useSourceControlWorktreeContext>
