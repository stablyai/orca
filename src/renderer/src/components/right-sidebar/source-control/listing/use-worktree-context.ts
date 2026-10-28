import { useMemo } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { resolveRepoWorktreeLaunchPlatform } from '@/lib/execution-host-facts'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
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

export function useSourceControlWorktreeContext() {
  const activeWorktree = useActiveWorktree()
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
  const statusReadError = useAppStore((s) =>
    activeWorktreeId ? s.gitStatusReadErrorByWorktree?.[activeWorktreeId] : undefined
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
  // Status and comparison refresh independently; drop totals measured against a stale fork point.
  const branchLineTotal =
    publishedBranchLineTotal && publishedBranchLineTotal.mergeBase === branchSummary?.mergeBase
      ? publishedBranchLineTotal
      : null
  const conflictOperation = useAppStore((s) =>
    activeWorktreeId ? (s.gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown') : 'unknown'
  )
  const conflictOperationsByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  // Preserve unknown upstream while fetching so workspace switches cannot flash Publish Branch.
  const remoteStatus = useAppStore((s) =>
    activeWorktreeId ? s.remoteStatusesByWorktree[activeWorktreeId] : undefined
  )
  const isRemoteOperationActive = useAppStore((s) => s.isRemoteOperationActive)
  const inFlightRemoteOpKind = useAppStore((s) => s.inFlightRemoteOpKind)
  const settings = useAppStore((s) => s.settings)
  const hostedReviewCacheKey =
    activeRepo && branchName
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
    activeRepo && branchName
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
  // Subscribe only to active repo/branch entries because background refresh replaces whole cache maps.
  const hostedReviewEntry = useAppStore((s) =>
    selectReviewCacheEntry(s.hostedReviewCache, hostedReviewCacheKey)
  )
  const hostedReviewEntryData = hostedReviewEntry?.data ?? null
  const activePrFromQueue = useAppStore((s) => selectReviewCacheData(s.prCache, activePrCacheKey))
  // Route Git and metadata to the repo owner; unresolved ownership must run nothing.
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
  // Quote for the workspace owner's OS, where agents run (#27971).
  const activeSourceControlLaunchPlatform =
    activeWorktree && activeRepo
      ? resolveRepoWorktreeLaunchPlatform(useAppStore.getState(), activeRepo, activeWorktree)
      : undefined
  // Mounted hidden sidebars need tab/open polling gates to avoid work without visible consumers.
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
    repositoryHuge,
    rightSidebarTab,
    settings,
    statusReadError,
    worktreeMap,
    worktreePath
  }
}

export type SourceControlWorktreeContext = ReturnType<typeof useSourceControlWorktreeContext>
