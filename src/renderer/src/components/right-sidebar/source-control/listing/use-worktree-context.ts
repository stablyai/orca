import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  useSourceControlScope,
  useSourceControlScopeOwner,
  useSourceControlState,
  useSourceControlSectionActive
} from '../panel/worktree-scope'
import { useMemo } from 'react'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { resolveRepoWorktreeLaunchPlatform } from '@/runtime/hosts/platform/execution-host-facts'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { selectRepoByIdForActiveWorkspace } from '@/store/repos/active-workspace-repository'
import { getGitHubPRCacheKey } from '../../../../../../shared/github/cache/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review/hosted-review-cache-identity'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  selectReviewCacheData,
  selectReviewCacheEntry
} from '../review/review-cache-entry-selection'

// Render inputs only; commands read current settings at their mutation boundary.
const SOURCE_CONTROL_SETTINGS = [
  'sourceControlAi',
  'commitMessageAi',
  'defaultTuiAgent',
  'disabledTuiAgents',
  'agentCmdOverrides',
  'agentDefaultArgs',
  'terminalWindowsShell',
  'sourceControlViewMode',
  'sourceControlGroupOrder',
  'sourceControlCompareAgainstUpstream'
] as const satisfies readonly (keyof NonNullable<AppState['settings']>)[]

export type SourceControlRenderSettings = Readonly<
  Pick<NonNullable<AppState['settings']>, (typeof SOURCE_CONTROL_SETTINGS)[number]>
>

const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntry[] = []
const EMPTY_BRANCH_CHANGE_ENTRIES: GitBranchChangeEntry[] = []

export function useSourceControlWorktreeContext() {
  const scope = useSourceControlScope()
  const scopeOwner = useSourceControlScopeOwner()
  const sectionActive = useSourceControlSectionActive()
  const selectedWorktree = useSourceControlState((s) =>
    !scope && s.activeWorktreeId
      ? (s.getKnownWorktreeById(
          s.activeWorktreeId,
          s.activeWorkspaceExecutionHostId ?? undefined
        ) ?? null)
      : null
  )
  const selectedWorktreeId = useSourceControlState((s) => (scope ? null : s.activeWorktreeId))
  const activeWorktree = scopeOwner?.worktree ?? selectedWorktree
  const activeWorktreeId = scope?.worktreeId ?? selectedWorktreeId
  const activeWorktreeInstanceId = activeWorktree?.instanceId
  const placementWorkspaceId = scope?.placementWorkspaceId ?? activeWorktreeId
  const activeGroupId = useSourceControlState((s) =>
    !scope && placementWorkspaceId ? s.activeGroupIdByWorktree[placementWorkspaceId] : undefined
  )
  const scopeWorktreeId = scope?.worktreeId
  const scopedWorktrees = useMemo(
    () => new Map(scopeWorktreeId ? [[scopeWorktreeId, true]] : []),
    [scopeWorktreeId]
  )
  // A section's history ends with its owner; only the ordinary panel caches several worktrees.
  const worktreeMap = useSourceControlState((s) =>
    scopeWorktreeId ? scopedWorktrees : getIndexedWorktreeMap(selectWorktreesByRepo(s))
  )
  const rightSidebarTab = useSourceControlState((s) => s.rightSidebarTab)
  const selectedRepo = useSourceControlState((s) =>
    scope ? null : selectRepoByIdForActiveWorkspace(s, activeWorktree?.repoId ?? null)
  )
  const activeRepo = scopeOwner?.repo ?? selectedRepo
  const activeRepoId = activeRepo?.id ?? null
  const activeRepoPath = activeRepo?.path ?? null
  const activeRepoConnectionId = activeRepo?.connectionId ?? null
  const activeRepoExecutionHostId = activeRepo?.executionHostId ?? null
  const gitIdentityDisplay = activeWorktree ? getWorktreeGitIdentityDisplay(activeWorktree) : null
  const branchName = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const entries = useSourceControlState((s) =>
    activeWorktreeId
      ? (s.gitStatusByWorktree[activeWorktreeId] ?? EMPTY_GIT_STATUS_ENTRIES)
      : EMPTY_GIT_STATUS_ENTRIES
  )
  const activeGitStatusHead = useSourceControlState((s) =>
    activeWorktreeId ? (s.gitStatusHeadByWorktree?.[activeWorktreeId] ?? null) : null
  )
  const repositoryHuge = useSourceControlState((s) =>
    activeWorktreeId ? s.gitStatusHugeByWorktree?.[activeWorktreeId] : undefined
  )
  const statusReadError = useSourceControlState((s) =>
    activeWorktreeId ? s.gitStatusReadErrorByWorktree?.[activeWorktreeId] : undefined
  )
  const branchEntries = useSourceControlState((s) =>
    activeWorktreeId
      ? (s.gitBranchChangesByWorktree[activeWorktreeId] ?? EMPTY_BRANCH_CHANGE_ENTRIES)
      : EMPTY_BRANCH_CHANGE_ENTRIES
  )
  const branchSummary = useSourceControlState((s) =>
    activeWorktreeId ? (s.gitBranchCompareSummaryByWorktree[activeWorktreeId] ?? null) : null
  )
  const publishedBranchLineTotal = useSourceControlState((s) =>
    activeWorktreeId ? (s.gitBranchLineTotalByWorktree?.[activeWorktreeId] ?? null) : null
  )
  // Status and comparison refresh independently; drop totals measured against a stale fork point.
  const branchLineTotal =
    publishedBranchLineTotal && publishedBranchLineTotal.mergeBase === branchSummary?.mergeBase
      ? publishedBranchLineTotal
      : null
  const conflictOperation = useSourceControlState((s) =>
    activeWorktreeId ? (s.gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown') : 'unknown'
  )
  // Preserve unknown upstream while fetching so workspace switches cannot flash Publish Branch.
  const remoteStatus = useSourceControlState((s) =>
    activeWorktreeId ? s.remoteStatusesByWorktree[activeWorktreeId] : undefined
  )
  const inFlightRemoteOpKind = useSourceControlState(
    (s) =>
      s.remoteOperations.findLast((operation) => operation.worktreeId === activeWorktreeId)?.kind ??
      null
  )
  const isRemoteOperationActive = useSourceControlState((s) => s.isRemoteOperationActive)
  const isRemoteOperationInAnotherWorktree =
    isRemoteOperationActive && inFlightRemoteOpKind === null
  const selectSettings = useMemo(() => {
    let previous: SourceControlRenderSettings | null = null
    return ({ settings }: AppState) => {
      if (
        previous &&
        settings &&
        SOURCE_CONTROL_SETTINGS.every((key) => Object.is(previous?.[key], settings[key]))
      ) {
        return previous
      }
      previous = settings && {
        sourceControlAi: settings.sourceControlAi,
        commitMessageAi: settings.commitMessageAi,
        defaultTuiAgent: settings.defaultTuiAgent,
        disabledTuiAgents: settings.disabledTuiAgents,
        agentCmdOverrides: settings.agentCmdOverrides,
        agentDefaultArgs: settings.agentDefaultArgs,
        terminalWindowsShell: settings.terminalWindowsShell,
        sourceControlViewMode: settings.sourceControlViewMode,
        sourceControlGroupOrder: settings.sourceControlGroupOrder,
        sourceControlCompareAgainstUpstream: settings.sourceControlCompareAgainstUpstream
      }
      return previous
    }
  }, [])
  const settings = useSourceControlState(selectSettings)
  const hostedReviewCacheKey =
    activeRepo && branchName
      ? getHostedReviewCacheKey(
          activeRepo.path,
          branchName,
          null,
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
          null,
          activeRepo.connectionId,
          activeRepo.executionHostId,
          true
        )
      : null
  // Subscribe only to active repo/branch entries because background refresh replaces whole cache maps.
  const hostedReviewEntry = useSourceControlState((s) =>
    selectReviewCacheEntry(s.hostedReviewCache, hostedReviewCacheKey)
  )
  const hostedReviewEntryData = hostedReviewEntry?.data ?? null
  const activePrFromQueue = useSourceControlState((s) =>
    selectReviewCacheData(s.prCache, activePrCacheKey)
  )
  // Route Git and metadata to the repo owner; unresolved ownership must run nothing.
  const activeRepoTarget = useMemo(
    () =>
      activeRepoId
        ? ipcOrRuntimeTargetForHostId(
            scope?.executionHostId ??
              getRepoExecutionHostId({
                connectionId: activeRepoConnectionId,
                executionHostId: activeRepoExecutionHostId
              })
          )
        : null,
    [activeRepoConnectionId, activeRepoExecutionHostId, activeRepoId, scope?.executionHostId]
  )
  const activeRepoRuntimeEnvironmentId =
    activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null
  const rightSidebarOpen = useSourceControlState((s) => s.rightSidebarOpen)

  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false
  const worktreePath = activeWorktree?.path ?? null
  const activeConnectionId = activeWorktreeId
    ? scope
      ? activeRepoConnectionId
      : (getConnectionId(activeWorktreeId) ?? activeRepoConnectionId)
    : null
  // Quote for the workspace owner's OS, where agents run (#27971).
  const activeSourceControlLaunchPlatform = useSourceControlState((state) =>
    activeWorktree && activeRepo
      ? resolveRepoWorktreeLaunchPlatform(state, activeRepo, activeWorktree)
      : undefined
  )
  // Mounted hidden sidebars and collapsed/off-screen sections keep their view but poll nothing.
  const isBranchVisible = rightSidebarTab === 'source-control' && rightSidebarOpen && sectionActive
  const hasUncommittedEntries = entries.length > 0

  return {
    scope,
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
    entries,
    gitIdentityDisplay,
    hasUncommittedEntries,
    hostedReviewCacheKey,
    hostedReviewEntry,
    hostedReviewEntryData,
    inFlightRemoteOpKind,
    isRemoteOperationInAnotherWorktree,
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
