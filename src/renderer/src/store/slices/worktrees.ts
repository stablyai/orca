/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  DetectedWorktreeListResult,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  LocalBaseRefRefreshResult,
  ForceDeleteWorktreeBranchResult,
  FolderWorkspace,
  GitHubPrStartPoint,
  Worktree,
  WorkspaceVisibleTabType,
  GitPushTarget,
  RemoveWorktreeResult,
  WorktreeLineage,
  WorkspaceLineage,
  WorktreeMeta
} from '../../../../shared/types'
import type { RuntimeWorktreeListResult } from '../../../../shared/runtime-types'
import {
  findWorktreeById,
  applyWorktreeUpdates,
  getRepoIdFromWorktreeId,
  type WorktreeSlice
} from './worktree-helpers'
import { findRepoForHost } from './repo-host-identity'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  RuntimeRpcCallError
} from '../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { getHostedReviewCacheKey, refreshHostedReviewCard } from './hosted-review'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from './github-cache-key'
import { moveFocusToRendererBeforeFocusedWebviewHidden } from './browser-webview-cleanup'
import { toast } from 'sonner'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-hibernation-output-activity'
import { branchName } from '@/lib/git-utils'
import { markInputQuietSchedulerInput, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import { clearSessionCommitDraftForWorktree } from '@/lib/source-control-commit-draft-session'
import { showLocalBaseRefUpdateSuggestionToast } from '@/components/sidebar/local-base-ref-suggestion-toast'
import { showPreservedBranchToast } from '@/components/sidebar/preserved-branch-toast'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  folderWorkspaceKey,
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
export type { WorktreeSlice, WorktreeDeleteState } from './worktree-helpers'

// Why: old runtime servers only have `worktree.list`; preserve the large-list
// UI hydration parity this slice used before `worktree.detectedList` existed.
const REMOTE_WORKTREE_LIST_PARITY_LIMIT = 10_000
const ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS = 300
const ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS = 450
const ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS = 180
const WORKTREE_REFRESH_CONCURRENCY = 5
const pendingActivationTerminalPrepCancels = new Map<string, () => void>()
const detachedHeadAutoDerivedDisplayNames = new Map<string, string>()
const folderWorkspaceWorktreeCache = new WeakMap<FolderWorkspace, Worktree>()
const hostedReviewPushTargetLookupsInFlight = new Set<string>()
const detectedWorktreeRefreshesInFlight = new Map<string, Promise<DetectedWorktreeListResult>>()

async function mapReposForWorktreeRefresh<TRepo extends { id: string }, TResult>(
  repos: readonly TRepo[],
  mapper: (repo: TRepo) => Promise<TResult>
): Promise<TResult[]> {
  const results = Array<TResult>(repos.length)
  let nextIndex = 0
  const workerCount = Math.min(WORKTREE_REFRESH_CONCURRENCY, repos.length)

  // Why: worktree refresh can be triggered during activation/startup. Keeping
  // repo scans bounded avoids one UI moment launching every git probe at once.
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < repos.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(repos[index])
      }
    })
  )

  return results
}

function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}

function getActivationSpawnSuppression(layout: TerminalLayoutSnapshot | undefined): true | number {
  const paneCount = Math.max(
    1,
    countTerminalLayoutLeaves(layout?.root),
    Object.keys(layout?.ptyIdsByLeafId ?? {}).length
  )
  return paneCount === 1 ? true : paneCount
}

function shouldDeferActivationTerminalPrep(): boolean {
  return typeof window !== 'undefined' && import.meta.env.MODE !== 'test'
}

function showLocalBaseRefRefreshToast(result: LocalBaseRefRefreshResult | undefined): void {
  if (!result || result.status === 'updated') {
    return
  }

  let reason: string
  switch (result.status) {
    case 'skipped_dirty_worktree':
      reason =
        'the worktree where it is checked out has uncommitted changes. Commit, stash, or discard those changes, then try again.'
      break
    case 'skipped_not_fast_forward':
      reason =
        'the local branch does not exist or cannot be fast-forwarded cleanly from the remote base. Check for local-only commits before updating it manually.'
      break
    case 'skipped_error':
      reason =
        'Git returned an error while updating the local ref. Check the repo for locked refs or unusual worktree state, then try again.'
      break
  }

  toast.warning(
    translate('auto.store.slices.worktrees.14bc053a47', 'Local {{value0}} was not refreshed', {
      value0: result.localBranch
    }),
    {
      description: translate(
        'auto.store.slices.worktrees.903b51c2ed',
        'Workspace created from {{value0}}, but Orca could not fast-forward local {{value1}} because {{value2}}',
        { value0: result.baseRef, value1: result.localBranch, value2: reason }
      )
    }
  )
}

function arraysShallowEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return !a?.length && !b?.length
  }
  return a.every((v, i) => v === b[i])
}

function areLineageRecordsEqual(
  a: WorktreeLineage | null | undefined,
  b: WorktreeLineage | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.worktreeId === b.worktreeId &&
    a.worktreeInstanceId === b.worktreeInstanceId &&
    a.parentWorktreeId === b.parentWorktreeId &&
    a.parentWorktreeInstanceId === b.parentWorktreeInstanceId &&
    a.origin === b.origin &&
    a.capture.source === b.capture.source &&
    a.capture.confidence === b.capture.confidence &&
    a.orchestrationRunId === b.orchestrationRunId &&
    a.taskId === b.taskId &&
    a.coordinatorHandle === b.coordinatorHandle &&
    a.createdByTerminalHandle === b.createdByTerminalHandle &&
    a.createdAt === b.createdAt
  )
}

function areWorktreesEqual(current: Worktree[] | undefined, next: Worktree[]): boolean {
  if (!current || current.length !== next.length) {
    return false
  }

  return current.every((worktree, index) => {
    const candidate = next[index]
    return (
      worktree.id === candidate.id &&
      worktree.instanceId === candidate.instanceId &&
      worktree.repoId === candidate.repoId &&
      worktree.projectId === candidate.projectId &&
      worktree.hostId === candidate.hostId &&
      worktree.projectHostSetupId === candidate.projectHostSetupId &&
      worktree.path === candidate.path &&
      worktree.head === candidate.head &&
      worktree.branch === candidate.branch &&
      worktree.isBare === candidate.isBare &&
      worktree.isMainWorktree === candidate.isMainWorktree &&
      worktree.isSparse === candidate.isSparse &&
      worktree.displayName === candidate.displayName &&
      worktree.comment === candidate.comment &&
      worktree.linkedIssue === candidate.linkedIssue &&
      worktree.linkedPR === candidate.linkedPR &&
      worktree.linkedGitLabMR === candidate.linkedGitLabMR &&
      worktree.linkedGitLabIssue === candidate.linkedGitLabIssue &&
      worktree.linkedBitbucketPR === candidate.linkedBitbucketPR &&
      worktree.linkedAzureDevOpsPR === candidate.linkedAzureDevOpsPR &&
      worktree.linkedGiteaPR === candidate.linkedGiteaPR &&
      worktree.isArchived === candidate.isArchived &&
      worktree.isUnread === candidate.isUnread &&
      worktree.isPinned === candidate.isPinned &&
      worktree.sortOrder === candidate.sortOrder &&
      worktree.manualOrder === candidate.manualOrder &&
      worktree.lastActivityAt === candidate.lastActivityAt &&
      worktree.workspaceStatus === candidate.workspaceStatus &&
      worktree.createdWithAgent === candidate.createdWithAgent &&
      worktree.pendingFirstAgentMessageRename === candidate.pendingFirstAgentMessageRename &&
      worktree.firstAgentMessageRenameError === candidate.firstAgentMessageRenameError &&
      worktree.baseRef === candidate.baseRef &&
      worktree.pushTarget?.remoteName === candidate.pushTarget?.remoteName &&
      worktree.pushTarget?.branchName === candidate.pushTarget?.branchName &&
      worktree.pushTarget?.remoteUrl === candidate.pushTarget?.remoteUrl &&
      worktree.sparseBaseRef === candidate.sparseBaseRef &&
      arraysShallowEqual(worktree.sparseDirectories, candidate.sparseDirectories) &&
      arraysShallowEqual(worktree.priorWorktreeIds, candidate.priorWorktreeIds) &&
      (worktree as WorktreeWithLineage).parentWorktreeId ===
        (candidate as WorktreeWithLineage).parentWorktreeId &&
      arraysShallowEqual(
        (worktree as WorktreeWithLineage).childWorktreeIds,
        (candidate as WorktreeWithLineage).childWorktreeIds
      ) &&
      areLineageRecordsEqual(
        (worktree as WorktreeWithLineage).lineage,
        (candidate as WorktreeWithLineage).lineage
      )
    )
  })
}

function areDetectedWorktreeResultsEqual(
  current: DetectedWorktreeListResult | undefined,
  next: DetectedWorktreeListResult
): boolean {
  return Boolean(
    current &&
    current.repoId === next.repoId &&
    current.authoritative === next.authoritative &&
    current.source === next.source &&
    areWorktreesEqual(current.worktrees, next.worktrees) &&
    current.worktrees.every((worktree, index) => {
      const candidate = next.worktrees[index]
      return (
        worktree.ownership === candidate.ownership &&
        worktree.selectedCheckout === candidate.selectedCheckout &&
        worktree.visible === candidate.visible
      )
    })
  )
}

function toVisibleTabType(contentType: string): WorkspaceVisibleTabType {
  if (contentType === 'browser' || contentType === 'terminal' || contentType === 'simulator') {
    return contentType
  }
  return 'editor'
}

const FORCE_RETRYABLE_WORKTREE_REMOVAL_MESSAGES = [
  'Worktree has uncommitted or untracked changes',
  'contains modified or untracked files',
  'Worktree is no longer registered with Git but its directory remains',
  'Worktree is no longer registered with Git and its directory is already gone'
] as const

// Why: local preflight formatting can surface raw git porcelain instead of the
// friendly dirty-worktree message; only those status prefixes are forceable.
const FORMATTED_DIRTY_WORKTREE_REMOVAL_PATTERN =
  /Failed to delete worktree at [^\n]*\.\s*(?:(?:[MADRCUT][ MADRCUT]| [MADRCUT]|\?\?)\s+\S)/

function canRetryWorktreeRemovalWithForce(error: string, force: boolean | undefined): boolean {
  if (force) {
    return false
  }
  // Why: force only helps backend safety refusals that are explicitly safe to
  // retry with user confirmation; transport/provider errors need recovery first.
  return (
    FORCE_RETRYABLE_WORKTREE_REMOVAL_MESSAGES.some((message) => error.includes(message)) ||
    FORMATTED_DIRTY_WORKTREE_REMOVAL_PATTERN.test(error)
  )
}

type WorktreeWithLineage = Worktree & {
  parentWorktreeId?: string | null
  childWorktreeIds?: string[]
  lineage?: WorktreeLineage | null
}

function toVisibleWorktree(worktree: DetectedWorktreeListResult['worktrees'][number]): Worktree {
  const {
    ownership: _ownership,
    selectedCheckout: _selectedCheckout,
    visible: _visible,
    ...base
  } = worktree
  return base
}

// Why: runtime worktree payloads arrive from the owning host's own perspective,
// so their hostId defaults to "local" even for remote checkouts. Re-stamp them
// with the repo's execution host so per-worktree host resolution doesn't route
// remote terminals to the local machine. Local-owned repos are left untouched,
// so an explicit local worktree still overrides a runtime repo owner.
function withRepoHostId<T extends { hostId?: ExecutionHostId }>(
  worktree: T,
  hostId: ExecutionHostId
): T {
  return hostId === LOCAL_EXECUTION_HOST_ID ? worktree : { ...worktree, hostId }
}

function repoHostId(
  state: Pick<AppState, 'repos' | 'settings'>,
  repoId: string,
  hostId?: ExecutionHostId | null
): ExecutionHostId {
  const repo = findRepoForHost(state.repos, repoId, { hostId, settings: state.settings })
  return repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
}

function toVisibleWorktrees(
  result: DetectedWorktreeListResult,
  hostId: ExecutionHostId
): Worktree[] {
  return result.worktrees
    .filter((worktree) => worktree.visible)
    .map(toVisibleWorktree)
    .map((worktree) => withRepoHostId(worktree, hostId))
}

function getHydratedSessionWorktreeIdsForRepo(state: AppState, repoId: string): string[] {
  return Object.keys(state.tabsByWorktree).filter((id) => getRepoIdFromWorktreeId(id) === repoId)
}

type WorktreeHostMatchOptions = {
  unhostedWorktreesMatchHost?: boolean
}

type RepoHostSummary = {
  count: number
  onlyHostId?: ExecutionHostId
}

const repoHostSummariesByRepos = new WeakMap<AppState['repos'], Map<string, RepoHostSummary>>()

function getRepoHostSummaries(repos: AppState['repos']): Map<string, RepoHostSummary> {
  const cached = repoHostSummariesByRepos.get(repos)
  if (cached) {
    return cached
  }

  const summaries = new Map<string, RepoHostSummary>()
  for (const repo of repos) {
    const current = summaries.get(repo.id)
    if (current) {
      summaries.set(repo.id, { count: current.count + 1 })
    } else {
      summaries.set(repo.id, { count: 1, onlyHostId: getRepoExecutionHostId(repo) })
    }
  }
  repoHostSummariesByRepos.set(repos, summaries)
  return summaries
}

function unhostedWorktreesMatchRefreshHost(
  state: Pick<AppState, 'repos'>,
  repoId: string,
  hostId: ExecutionHostId
): boolean {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }

  const summary = getRepoHostSummaries(state.repos).get(repoId)
  return summary?.count === 1 && summary.onlyHostId === hostId
}

function worktreeHostMatchOptions(
  state: Pick<AppState, 'repos'>,
  repoId: string,
  hostId: ExecutionHostId
): WorktreeHostMatchOptions {
  return {
    // Why: pre-host persisted runtime/SSH worktrees were stored without hostId.
    // Treat them as the sole repo owner's rows, but keep ambiguous duplicates local.
    unhostedWorktreesMatchHost: unhostedWorktreesMatchRefreshHost(state, repoId, hostId)
  }
}

function worktreeMatchesHost(
  worktree: { hostId?: ExecutionHostId },
  hostId: ExecutionHostId,
  options: WorktreeHostMatchOptions = {}
): boolean {
  if (worktree.hostId) {
    return worktree.hostId === hostId
  }
  return options.unhostedWorktreesMatchHost ?? hostId === LOCAL_EXECUTION_HOST_ID
}

function mergeWorktreesForHost<T extends { hostId?: ExecutionHostId }>(
  current: readonly T[] | undefined,
  refreshed: readonly T[],
  hostId: ExecutionHostId,
  options?: WorktreeHostMatchOptions
): T[] {
  // Why: host-scoped refreshes should replace that host in place so alternating
  // local/runtime refreshes do not churn sibling row order or sortEpoch.
  const existing = current ?? []
  const next: T[] = []
  let inserted = false

  for (const worktree of existing) {
    if (worktreeMatchesHost(worktree, hostId, options)) {
      if (!inserted) {
        next.push(...refreshed)
        inserted = true
      }
      continue
    }
    next.push(worktree)
  }

  return inserted ? next : [...next, ...refreshed]
}

function mergeDetectedWorktreesForHost(
  current: DetectedWorktreeListResult | undefined,
  refreshed: DetectedWorktreeListResult,
  hostId: ExecutionHostId,
  options?: WorktreeHostMatchOptions
): DetectedWorktreeListResult {
  const refreshedForHost = sanitizeHostedReviewLinksForBranchClears(
    refreshed.worktrees,
    current?.worktrees
  ).map((worktree) => withRepoHostId(worktree, hostId))
  return {
    ...refreshed,
    worktrees: mergeWorktreesForHost(current?.worktrees, refreshedForHost, hostId, options)
  }
}

function getKnownWorktreeIdsForPurge(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId
): string[] {
  const detected = state.detectedWorktreesByRepo[repoId]
  const knownIds = new Set<string>()
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  if (detected?.authoritative === true) {
    for (const worktree of detected.worktrees) {
      if (worktreeMatchesHost(worktree, hostId, matchOptions)) {
        knownIds.add(worktree.id)
      }
    }
  } else {
    for (const worktree of state.worktreesByRepo[repoId] ?? []) {
      if (worktreeMatchesHost(worktree, hostId, matchOptions)) {
        knownIds.add(worktree.id)
      }
    }
  }
  if (!state.hasHydratedWorktreePurge && matchOptions.unhostedWorktreesMatchHost === true) {
    // Why (#1158): hydration can preserve tab keys before worktree metadata exists;
    // the first authoritative scan still needs to reap deleted session-only keys.
    for (const id of getHydratedSessionWorktreeIdsForRepo(state, repoId)) {
      knownIds.add(id)
    }
  }
  return [...knownIds]
}

function getRemovedWorktreeIdsAfterAuthoritativeScan(
  state: AppState,
  repoId: string,
  detected: DetectedWorktreeListResult,
  hostId: ExecutionHostId
): string[] {
  if (!detected.authoritative) {
    return []
  }
  const detectedIds = new Set(detected.worktrees.map((worktree) => worktree.id))
  return getKnownWorktreeIdsForPurge(state, repoId, hostId).filter((id) => !detectedIds.has(id))
}

function toLegacyDetectedWorktreeResult(
  repoId: string,
  result: { worktrees: Worktree[] }
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'session-fallback',
    worktrees: result.worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}

function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

function applyDetectedWorktreeUpdates(
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo'],
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): AppState['detectedWorktreesByRepo'] {
  let changed = false
  const nextByRepo: AppState['detectedWorktreesByRepo'] = {}

  for (const [repoId, result] of Object.entries(detectedWorktreesByRepo)) {
    let repoChanged = false
    const nextWorktrees = result.worktrees.map((worktree) => {
      if (worktree.id !== worktreeId) {
        return worktree
      }
      repoChanged = true
      changed = true
      return { ...worktree, ...updates }
    })
    nextByRepo[repoId] = repoChanged ? { ...result, worktrees: nextWorktrees } : result
  }

  return changed ? nextByRepo : detectedWorktreesByRepo
}

function findKnownWorktreeById(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'>,
  worktreeId: string
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (workspace) => workspace.id === workspaceScope.folderWorkspaceId
    )
    if (!folderWorkspace) {
      return undefined
    }
    const cached = folderWorkspaceWorktreeCache.get(folderWorkspace)
    if (cached) {
      return cached
    }
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    folderWorkspaceWorktreeCache.set(folderWorkspace, worktree)
    return worktree
  }
  const visible = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (visible) {
    return visible
  }
  for (const result of Object.values(state.detectedWorktreesByRepo)) {
    const detected = result.worktrees.find((worktree) => worktree.id === worktreeId)
    if (detected) {
      return detected
    }
  }
  return undefined
}

function getFolderWorkspaceMetaUpdates(
  updates: Partial<WorktreeMeta>
): Partial<
  Pick<
    FolderWorkspace,
    | 'name'
    | 'comment'
    | 'isArchived'
    | 'isUnread'
    | 'isPinned'
    | 'sortOrder'
    | 'manualOrder'
    | 'lastActivityAt'
    | 'workspaceStatus'
    | 'createdWithAgent'
    | 'pendingFirstAgentMessageRename'
    | 'firstAgentMessageRenameError'
  >
> {
  const next: Partial<
    Pick<
      FolderWorkspace,
      | 'name'
      | 'comment'
      | 'isArchived'
      | 'isUnread'
      | 'isPinned'
      | 'sortOrder'
      | 'manualOrder'
      | 'lastActivityAt'
      | 'workspaceStatus'
      | 'createdWithAgent'
      | 'pendingFirstAgentMessageRename'
      | 'firstAgentMessageRenameError'
    >
  > = {}
  if (updates.displayName !== undefined) {
    next.name = updates.displayName
    next.pendingFirstAgentMessageRename = false
    next.firstAgentMessageRenameError = null
  }
  if (updates.comment !== undefined) {
    next.comment = updates.comment
    next.lastActivityAt = Date.now()
  }
  if (updates.isArchived !== undefined) {
    next.isArchived = updates.isArchived
  }
  if (updates.isUnread !== undefined) {
    next.isUnread = updates.isUnread
  }
  if (updates.isPinned !== undefined) {
    next.isPinned = updates.isPinned
  }
  if (updates.sortOrder !== undefined) {
    next.sortOrder = updates.sortOrder
  }
  if (updates.manualOrder !== undefined) {
    next.manualOrder = updates.manualOrder
  }
  if (updates.lastActivityAt !== undefined) {
    next.lastActivityAt = updates.lastActivityAt
  }
  if (updates.workspaceStatus !== undefined) {
    next.workspaceStatus = updates.workspaceStatus
  }
  if (updates.createdWithAgent !== undefined) {
    next.createdWithAgent = updates.createdWithAgent
  }
  if (updates.pendingFirstAgentMessageRename !== undefined) {
    next.pendingFirstAgentMessageRename = updates.pendingFirstAgentMessageRename
  }
  if (updates.firstAgentMessageRenameError !== undefined) {
    next.firstAgentMessageRenameError = updates.firstAgentMessageRenameError
  }
  return next
}

function isRuntimeSelectorNotFoundError(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'cause' in error &&
    isRuntimeSelectorNotFoundError((error as { cause?: unknown }).cause)
  ) {
    return true
  }
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null
  const responseCode =
    error &&
    typeof error === 'object' &&
    'response' in error &&
    typeof (error as { response?: { error?: { code?: unknown } } }).response?.error?.code ===
      'string'
      ? (error as { response: { error: { code: string } } }).response.error.code
      : null
  const responseMessage =
    error &&
    typeof error === 'object' &&
    'response' in error &&
    typeof (error as { response?: { error?: { message?: unknown } } }).response?.error?.message ===
      'string'
      ? (error as { response: { error: { message: string } } }).response.error.message
      : null
  const message = error instanceof Error ? error.message : String(error)
  return (
    message === 'selector_not_found' ||
    message.includes('selector_not_found') ||
    code === 'selector_not_found' ||
    responseCode === 'selector_not_found' ||
    responseMessage === 'selector_not_found' ||
    String(error).includes('selector_not_found')
  )
}

function replaceWorktreeInRepoLists(
  worktreesByRepo: Record<string, Worktree[]>,
  updatedWorktree: Worktree
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(updatedWorktree.id)
  const current = worktreesByRepo[repoId]
  if (!current) {
    return worktreesByRepo
  }
  return {
    ...worktreesByRepo,
    [repoId]: current.map((worktree) =>
      worktree.id === updatedWorktree.id ? updatedWorktree : worktree
    )
  }
}

function settingsForRepoOwner(
  state: Pick<AppState, 'repos' | 'settings'>,
  repoId: string,
  hostId?: ExecutionHostId | null
) {
  const repo = findRepoForHost(state.repos, repoId, { hostId, settings: state.settings })
  if (!repo) {
    return state.settings
  }
  return settingsForKnownRepoOwner(state.settings, repo)
}

function settingsForKnownRepoOwner(
  settings: AppState['settings'],
  repo: { connectionId?: string | null; executionHostId?: ExecutionHostId | null }
) {
  if (!repo.executionHostId && !repo.connectionId) {
    return settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (parsed?.kind === 'runtime') {
    return settings
      ? { ...settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  if (parsed?.kind === 'local' && settings?.activeRuntimeEnvironmentId) {
    return { ...settings, activeRuntimeEnvironmentId: null }
  }
  if (parsed?.kind !== 'ssh') {
    return settings
  }
  // Why: SSH repos are owned by the desktop client/SSH provider, not the
  // currently focused runtime server.
  return settings
    ? { ...settings, activeRuntimeEnvironmentId: null }
    : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
}

function settingsForExecutionHostOwner(
  settings: AppState['settings'],
  executionHostId: string | null | undefined
) {
  const parsed = parseExecutionHostId(executionHostId)
  if (parsed?.kind === 'runtime') {
    return settings
      ? { ...settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  if (parsed?.kind === 'local' || parsed?.kind === 'ssh') {
    return settings
      ? { ...settings, activeRuntimeEnvironmentId: null }
      : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
  }
  return settings
}

function settingsForWorktreeOwner(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string
) {
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (worktree?.hostId) {
    return settingsForExecutionHostOwner(state.settings, worktree.hostId)
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const detected = state.detectedWorktreesByRepo[repoId]?.worktrees.find(
    (entry) => entry.id === worktreeId
  )
  if (detected?.hostId) {
    return settingsForExecutionHostOwner(state.settings, detected.hostId)
  }
  return settingsForRepoOwner(state, repoId)
}

async function listDetectedWorktreesForRepo(
  settings: AppState['settings'],
  repoId: string
): Promise<DetectedWorktreeListResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    const worktreesApi = window.api.worktrees as typeof window.api.worktrees & {
      listDetected?: typeof window.api.worktrees.listDetected
    }
    if (typeof worktreesApi.listDetected === 'function') {
      return worktreesApi.listDetected({ repoId })
    }
    const legacyWorktrees = await worktreesApi.list({ repoId })
    return toLegacyDetectedWorktreeResult(repoId, { worktrees: legacyWorktrees })
  }
  try {
    return await callRuntimeRpc<DetectedWorktreeListResult>(
      target,
      'worktree.detectedList',
      { repo: repoId },
      { timeoutMs: 15_000 }
    )
  } catch (error) {
    if (!isRuntimeMethodNotFoundError(error)) {
      throw error
    }
    const legacy = await callRuntimeRpc<RuntimeWorktreeListResult>(
      target,
      'worktree.list',
      { repo: repoId, limit: REMOTE_WORKTREE_LIST_PARITY_LIMIT },
      { timeoutMs: 15_000 }
    )
    return toLegacyDetectedWorktreeResult(repoId, legacy)
  }
}

function detectedWorktreeRefreshKey(
  settings: AppState['settings'],
  repoId: string,
  options: { executionHostId: ExecutionHostId; requireAuthoritative?: boolean }
): string {
  const target = getActiveRuntimeTarget(settings)
  const targetKey = target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`
  return [
    repoId,
    options.executionHostId,
    targetKey,
    options.requireAuthoritative === true ? 'authoritative' : 'best-effort'
  ].join('\n')
}

async function listDetectedWorktreesForRepoCoalesced(
  settings: AppState['settings'],
  repoId: string,
  options: { executionHostId: ExecutionHostId; requireAuthoritative?: boolean }
): Promise<DetectedWorktreeListResult> {
  const key = detectedWorktreeRefreshKey(settings, repoId, options)
  const existing = detectedWorktreeRefreshesInFlight.get(key)
  if (existing) {
    return existing
  }
  // Why: startup/event fan-out can ask for the same repo/host refresh many
  // times at once; share only the scan promise so state merge semantics stay local.
  const refresh = listDetectedWorktreesForRepo(settings, repoId)
  detectedWorktreeRefreshesInFlight.set(key, refresh)
  try {
    return await refresh
  } finally {
    if (detectedWorktreeRefreshesInFlight.get(key) === refresh) {
      detectedWorktreeRefreshesInFlight.delete(key)
    }
  }
}

async function listWorktreeLineageForRuntime(settings: AppState['settings']): Promise<{
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
}> {
  const target = getActiveRuntimeTarget(settings)
  type LineageListResponse = {
    lineage?: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
  }
  const normalizeLineageResponse = (value: Record<string, WorktreeLineage> | LineageListResponse) =>
    Object.prototype.hasOwnProperty.call(value, 'lineage') ||
    Object.prototype.hasOwnProperty.call(value, 'workspaceLineage')
      ? {
          worktreeLineageById: (value as LineageListResponse).lineage ?? {},
          workspaceLineageByChildKey: (value as LineageListResponse).workspaceLineage ?? {}
        }
      : {
          worktreeLineageById: value as Record<string, WorktreeLineage>,
          workspaceLineageByChildKey: {}
        }
  if (target.kind === 'local') {
    return normalizeLineageResponse(await window.api.worktrees.listLineage())
  }
  return normalizeLineageResponse(
    await callRuntimeRpc<{
      lineage: Record<string, WorktreeLineage>
      workspaceLineage?: Record<string, WorkspaceLineage>
    }>(target, 'worktree.lineageList', undefined, { timeoutMs: 15_000 })
  )
}

function projectWorktreeLineageToWorkspaceLineage(
  worktreeId: string,
  lineage: WorktreeLineage | null,
  current: Record<string, WorkspaceLineage>
): Record<string, WorkspaceLineage> {
  const childWorkspaceKey = worktreeWorkspaceKey(worktreeId)
  const next = { ...current }
  if (!lineage) {
    delete next[childWorkspaceKey]
    return next
  }
  next[childWorkspaceKey] = {
    childWorkspaceKey,
    childInstanceId: lineage.worktreeInstanceId,
    parentWorkspaceKey: worktreeWorkspaceKey(lineage.parentWorktreeId),
    parentInstanceId: lineage.parentWorktreeInstanceId,
    origin: lineage.origin,
    capture: lineage.capture,
    ...(lineage.taskId ? { taskId: lineage.taskId } : {}),
    ...(lineage.orchestrationRunId ? { orchestrationRunId: lineage.orchestrationRunId } : {}),
    ...(lineage.coordinatorHandle ? { coordinatorHandle: lineage.coordinatorHandle } : {}),
    ...(lineage.createdByTerminalHandle
      ? { createdByTerminalHandle: lineage.createdByTerminalHandle }
      : {}),
    createdAt: lineage.createdAt
  }
  return next
}

type WorktreeLineageUpdateResult = {
  target: ReturnType<typeof getActiveRuntimeTarget>
  lineage: WorktreeLineage | null
  updatedRemoteWorktree?: WorktreeWithLineage
}

async function setWorktreeLineageForRuntime(
  settings: AppState['settings'],
  worktreeId: string,
  args: { parentWorktreeId?: string; noParent?: boolean }
): Promise<WorktreeLineageUpdateResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return {
      target,
      lineage: await window.api.worktrees.updateLineage({ worktreeId, ...args })
    }
  }
  const result = await callRuntimeRpc<{ worktree: WorktreeWithLineage }>(
    target,
    'worktree.set',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      ...(args.parentWorktreeId
        ? { parentWorktree: toRuntimeWorktreeSelector(args.parentWorktreeId) }
        : {}),
      ...(args.noParent === true ? { noParent: true } : {})
    },
    { timeoutMs: 15_000 }
  )
  return {
    target,
    lineage: result.worktree.lineage ?? null,
    updatedRemoteWorktree: result.worktree
  }
}

function applyWorktreeLineageUpdate(
  set: Parameters<StateCreator<AppState>>[0],
  worktreeId: string,
  result: WorktreeLineageUpdateResult
): void {
  set((s) => {
    const next = { ...s.worktreeLineageById }
    if (result.lineage) {
      next[worktreeId] = result.lineage
    } else {
      delete next[worktreeId]
    }
    return {
      worktreeLineageById: next,
      workspaceLineageByChildKey: projectWorktreeLineageToWorkspaceLineage(
        worktreeId,
        result.lineage,
        s.workspaceLineageByChildKey
      ),
      worktreesByRepo:
        result.target.kind === 'local' || !result.updatedRemoteWorktree
          ? s.worktreesByRepo
          : replaceWorktreeInRepoLists(
              s.worktreesByRepo,
              withRepoHostId(
                result.updatedRemoteWorktree,
                repoHostId(s, getRepoIdFromWorktreeId(result.updatedRemoteWorktree.id))
              )
            ),
      sortEpoch: s.sortEpoch + 1
    }
  })
}

async function refreshWorktreeLineageForSettings(
  settings: AppState['settings'],
  set: Parameters<StateCreator<AppState>>[0]
): Promise<void> {
  const lineage = await listWorktreeLineageForRuntime(settings)
  const hostId = getSettingsFocusedExecutionHostId(settings)
  set((s) => ({
    worktreeLineageById: mergeLineageForHost(s, hostId, lineage.worktreeLineageById),
    workspaceLineageByChildKey: mergeWorkspaceLineageForHost(
      s,
      hostId,
      lineage.workspaceLineageByChildKey
    )
  }))
}

async function refreshRemoteWorktreeLineageBestEffort(
  settings: AppState['settings'],
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
): Promise<void> {
  if (getActiveRuntimeTarget(settings).kind === 'local') {
    return
  }
  try {
    const lineage = await listWorktreeLineageForRuntime(settings)
    const hostId = getSettingsFocusedExecutionHostId(settings)
    set((s) => ({
      worktreeLineageById: mergeLineageForHost(s, hostId, lineage.worktreeLineageById),
      workspaceLineageByChildKey: mergeWorkspaceLineageForHost(
        s,
        hostId,
        lineage.workspaceLineageByChildKey
      )
    }))
  } catch (err) {
    // Why: lineage is supplemental to the worktree list. A remote timeout here
    // must not discard a successful worktree refresh.
    console.error('Failed to fetch worktree lineage:', err)
  }
}

function getWorktreeHostId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string
): ExecutionHostId | null {
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (worktree?.hostId) {
    return worktree.hostId
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const detected = state.detectedWorktreesByRepo[repoId]?.worktrees.find(
    (entry) => entry.id === worktreeId
  )
  if (detected?.hostId) {
    return detected.hostId
  }
  const repo = findRepoForHost(state.repos, repoId, { settings: state.settings })
  return repo ? getRepoExecutionHostId(repo) : null
}

function mergeLineageForHost(
  state: Pick<
    AppState,
    'repos' | 'settings' | 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'worktreeLineageById'
  >,
  hostId: ExecutionHostId,
  lineage: Record<string, WorktreeLineage>
): Record<string, WorktreeLineage> {
  const next: Record<string, WorktreeLineage> = {}
  for (const [worktreeId, existing] of Object.entries(state.worktreeLineageById)) {
    if (getWorktreeHostId(state, worktreeId) !== hostId) {
      next[worktreeId] = existing
    }
  }
  return { ...next, ...lineage }
}

function mergeWorkspaceLineageForHost(
  state: Pick<
    AppState,
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
    | 'workspaceLineageByChildKey'
  >,
  hostId: ExecutionHostId,
  lineage: Record<string, WorkspaceLineage>
): Record<string, WorkspaceLineage> {
  const next: Record<string, WorkspaceLineage> = {}
  for (const [childKey, existing] of Object.entries(state.workspaceLineageByChildKey)) {
    const childScope = parseWorkspaceKey(existing.childWorkspaceKey)
    const childHostId =
      childScope?.type === 'worktree' ? getWorktreeHostId(state, childScope.worktreeId) : null
    // A focused host refresh can no longer prove unknown-host child rows are current.
    if (childScope?.type !== 'worktree' || (childHostId !== null && childHostId !== hostId)) {
      next[childKey] = existing
    }
  }
  return { ...next, ...lineage }
}

async function persistWorktreeMeta(
  settings: AppState['settings'],
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    await window.api.worktrees.updateMeta({ worktreeId, updates })
    return
  }
  await callRuntimeRpc(
    target,
    'worktree.set',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      ...encodePushTargetClearForRuntimeRpc(updates)
    },
    { timeoutMs: 15_000 }
  )
}

async function resolveGitHubReviewPushTarget(
  settings: AppState['settings'],
  repoId: string,
  prNumber: number
): Promise<GitPushTarget | undefined> {
  try {
    const target = getActiveRuntimeTarget(settings)
    const result =
      target.kind === 'local'
        ? await window.api.worktrees.resolvePrBase({ repoId, prNumber })
        : await callRuntimeRpc<GitHubPrStartPoint | { error: string }>(
            target,
            'worktree.resolvePrBase',
            { repo: repoId, prNumber },
            { timeoutMs: 30_000 }
          )
    if ('error' in result) {
      console.warn(`Failed to resolve push target for PR #${prNumber}: ${result.error}`)
      return undefined
    }
    return result.pushTarget
  } catch (error) {
    console.warn(
      `Failed to resolve push target for PR #${prNumber}:`,
      error instanceof Error ? error.message : error
    )
    return undefined
  }
}

async function resolveGitLabReviewPushTarget(
  settings: AppState['settings'],
  repoId: string,
  mrIid: number
): Promise<GitPushTarget | undefined> {
  try {
    const target = getActiveRuntimeTarget(settings)
    const result =
      target.kind === 'local'
        ? await window.api.worktrees.resolveMrBase({ repoId, mrIid })
        : await callRuntimeRpc<
            | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
            | {
                error: string
              }
          >(target, 'worktree.resolveMrBase', { repo: repoId, mrIid }, { timeoutMs: 30_000 })
    if ('error' in result) {
      console.warn(`Failed to resolve push target for MR !${mrIid}: ${result.error}`)
      return undefined
    }
    return result.pushTarget
  } catch (error) {
    console.warn(
      `Failed to resolve push target for MR !${mrIid}:`,
      error instanceof Error ? error.message : error
    )
    return undefined
  }
}

function getHostedReviewPushTargetLookup(worktree: Worktree): {
  key: string
  resolve: (settings: AppState['settings']) => Promise<GitPushTarget | undefined>
} | null {
  const hostScope = worktree.hostId ?? ''
  if (isPositiveHostedReviewNumber(worktree.linkedPR)) {
    const prNumber = worktree.linkedPR
    return {
      key: `${worktree.id}:${hostScope}:github:${prNumber}`,
      resolve: (settings) => resolveGitHubReviewPushTarget(settings, worktree.repoId, prNumber)
    }
  }
  if (isPositiveHostedReviewNumber(worktree.linkedGitLabMR)) {
    const mrIid = worktree.linkedGitLabMR
    return {
      key: `${worktree.id}:${hostScope}:gitlab:${mrIid}`,
      resolve: (settings) => resolveGitLabReviewPushTarget(settings, worktree.repoId, mrIid)
    }
  }
  return null
}

function isPositiveHostedReviewNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

type HostedReviewLinkKey =
  | 'linkedPR'
  | 'linkedGitLabMR'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'

const HOSTED_REVIEW_LINK_KEYS: readonly HostedReviewLinkKey[] = [
  'linkedPR',
  'linkedGitLabMR',
  'linkedBitbucketPR',
  'linkedAzureDevOpsPR',
  'linkedGiteaPR'
]

const CLEARED_HOSTED_REVIEW_LINK_UPDATES: Pick<WorktreeMeta, HostedReviewLinkKey | 'pushTarget'> = {
  linkedPR: null,
  linkedGitLabMR: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null,
  pushTarget: undefined
}

const hostedReviewLinkMutationGenerationByWorktreeId = new Map<string, number>()
const hostedReviewLinkClearTombstonesByWorktreeId = new Map<
  string,
  { branch: string; branchIdentity: string; generation: number; head?: string }
>()
const hostedReviewLinkWorktreeIdAliases = new Map<string, string>()

function hasHostedReviewLinks(worktree: Worktree): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => worktree[key] != null)
}

function hasBranchScopedHostedReviewContext(worktree: Worktree): boolean {
  return hasHostedReviewLinks(worktree) || worktree.pushTarget !== undefined
}

function hasHostedReviewLinkUpdates(updates: Partial<WorktreeMeta>): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => key in updates) || 'pushTarget' in updates
}

function getHostedReviewLinkMutationGeneration(worktreeId: string): number {
  return hostedReviewLinkMutationGenerationByWorktreeId.get(worktreeId) ?? 0
}

function bumpHostedReviewLinkMutationGeneration(worktreeId: string): void {
  hostedReviewLinkMutationGenerationByWorktreeId.set(
    worktreeId,
    getHostedReviewLinkMutationGeneration(worktreeId) + 1
  )
  hostedReviewLinkClearTombstonesByWorktreeId.delete(worktreeId)
  pruneHostedReviewLinkWorktreeAliasesForId(worktreeId)
}

function pruneHostedReviewLinkMutationGenerations(worktreeIds: Iterable<string>): void {
  for (const worktreeId of worktreeIds) {
    hostedReviewLinkMutationGenerationByWorktreeId.delete(worktreeId)
    hostedReviewLinkClearTombstonesByWorktreeId.delete(worktreeId)
    hostedReviewLinkWorktreeIdAliases.delete(worktreeId)
    for (const [oldWorktreeId, newWorktreeId] of hostedReviewLinkWorktreeIdAliases) {
      if (newWorktreeId === worktreeId) {
        hostedReviewLinkWorktreeIdAliases.delete(oldWorktreeId)
      }
    }
  }
}

function resolveHostedReviewLinkWorktreeId(worktreeId: string): string {
  let current = worktreeId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const next = hostedReviewLinkWorktreeIdAliases.get(current)
    if (!next) {
      return current
    }
    current = next
  }
  return worktreeId
}

function pruneHostedReviewLinkWorktreeAliasesForId(worktreeId: string): void {
  for (const [alias, target] of Array.from(hostedReviewLinkWorktreeIdAliases)) {
    if (
      alias === worktreeId ||
      target === worktreeId ||
      resolveHostedReviewLinkWorktreeId(alias) === worktreeId
    ) {
      hostedReviewLinkWorktreeIdAliases.delete(alias)
    }
  }
}

function migrateHostedReviewLinkMutationGeneration(
  oldWorktreeId: string,
  newWorktreeId: string
): void {
  const tombstone = hostedReviewLinkClearTombstonesByWorktreeId.get(oldWorktreeId)
  for (const [alias, target] of hostedReviewLinkWorktreeIdAliases) {
    if (target === oldWorktreeId) {
      if (tombstone) {
        hostedReviewLinkWorktreeIdAliases.set(alias, newWorktreeId)
      } else {
        hostedReviewLinkWorktreeIdAliases.delete(alias)
      }
    }
  }
  const hasGeneration = hostedReviewLinkMutationGenerationByWorktreeId.has(oldWorktreeId)
  if (tombstone) {
    hostedReviewLinkWorktreeIdAliases.set(oldWorktreeId, newWorktreeId)
  }
  if (hasGeneration) {
    hostedReviewLinkMutationGenerationByWorktreeId.set(
      newWorktreeId,
      getHostedReviewLinkMutationGeneration(oldWorktreeId)
    )
    hostedReviewLinkMutationGenerationByWorktreeId.delete(oldWorktreeId)
  }
  if (tombstone) {
    hostedReviewLinkClearTombstonesByWorktreeId.set(newWorktreeId, tombstone)
    hostedReviewLinkClearTombstonesByWorktreeId.delete(oldWorktreeId)
  }
}

export function getHostedReviewLinkMutationGenerationForTests(worktreeId: string): number {
  return getHostedReviewLinkMutationGeneration(worktreeId)
}

export function getHostedReviewLinkWorktreeAliasCountForTests(): number {
  return hostedReviewLinkWorktreeIdAliases.size
}

export function resetHostedReviewLinkMutationGenerationForTests(): void {
  hostedReviewLinkMutationGenerationByWorktreeId.clear()
  hostedReviewLinkClearTombstonesByWorktreeId.clear()
  hostedReviewLinkWorktreeIdAliases.clear()
}

function hostedReviewLinksAreCleared(worktree: Worktree): boolean {
  return HOSTED_REVIEW_LINK_KEYS.every((key) => worktree[key] == null) && !worktree.pushTarget
}

function getHostedReviewLinkUpdates(
  worktree: Worktree
): Pick<WorktreeMeta, HostedReviewLinkKey | 'pushTarget'> {
  return {
    linkedPR: worktree.linkedPR ?? null,
    linkedGitLabMR: worktree.linkedGitLabMR ?? null,
    linkedBitbucketPR: worktree.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: worktree.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: worktree.linkedGiteaPR ?? null,
    pushTarget: worktree.pushTarget
  }
}

function canonicalHostedReviewBranchIdentity(branch: string): string {
  return branchName(branch).trim()
}

function rememberHostedReviewLinkClear(
  worktreeId: string,
  branch: string,
  generation: number,
  head?: string
): void {
  hostedReviewLinkClearTombstonesByWorktreeId.set(worktreeId, {
    branch,
    branchIdentity: canonicalHostedReviewBranchIdentity(branch),
    generation,
    head
  })
}

function sanitizeHostedReviewLinksForBranchClear<
  T extends Pick<Worktree, 'id' | 'branch'> &
    Partial<Pick<Worktree, HostedReviewLinkKey | 'pushTarget' | 'head'>>
>(worktree: T, currentWorktrees?: readonly T[]): T {
  const hostedReviewWorktreeId = resolveHostedReviewLinkWorktreeId(worktree.id)
  const tombstone = hostedReviewLinkClearTombstonesByWorktreeId.get(hostedReviewWorktreeId)
  const hasBranchScopedContext =
    HOSTED_REVIEW_LINK_KEYS.some((key) => worktree[key] != null) ||
    worktree.pushTarget !== undefined
  if (
    !tombstone ||
    tombstone.generation !== getHostedReviewLinkMutationGeneration(hostedReviewWorktreeId) ||
    !hasBranchScopedContext
  ) {
    return worktree
  }
  const current = currentWorktrees?.find(
    (entry) =>
      entry.id === worktree.id ||
      resolveHostedReviewLinkWorktreeId(entry.id) === hostedReviewWorktreeId
  )
  const currentClean =
    current &&
    !HOSTED_REVIEW_LINK_KEYS.some((key) => current[key] != null) &&
    current.pushTarget === undefined
      ? current
      : null
  const guardBranch = currentClean ? currentClean.branch : tombstone.branch
  const guardHead = currentClean ? currentClean.head : tombstone.head
  return {
    ...worktree,
    branch: guardBranch,
    ...(guardHead !== undefined ? { head: guardHead } : {}),
    ...CLEARED_HOSTED_REVIEW_LINK_UPDATES
  }
}

function sanitizeHostedReviewLinksForBranchClears<
  T extends Pick<Worktree, 'id' | 'branch'> &
    Partial<Pick<Worktree, HostedReviewLinkKey | 'pushTarget' | 'head'>>
>(worktrees: readonly T[], currentWorktrees?: readonly T[]): T[] {
  let changed = false
  const sanitized = worktrees.map((worktree) => {
    const next = sanitizeHostedReviewLinksForBranchClear(worktree, currentWorktrees)
    if (next !== worktree) {
      changed = true
    }
    return next
  })
  return changed ? sanitized : [...worktrees]
}

function applyHostedReviewLinkClear(
  set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  worktreeId: string
): void {
  set((s) => {
    const nextWorktrees = applyWorktreeUpdates(
      s.worktreesByRepo,
      worktreeId,
      CLEARED_HOSTED_REVIEW_LINK_UPDATES
    )
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      CLEARED_HOSTED_REVIEW_LINK_UPDATES
    )
    if (
      nextWorktrees === s.worktreesByRepo &&
      nextDetectedWorktrees === s.detectedWorktreesByRepo
    ) {
      return {}
    }
    return {
      ...(nextWorktrees !== s.worktreesByRepo
        ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
        : {}),
      ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
        ? { detectedWorktreesByRepo: nextDetectedWorktrees }
        : {})
    }
  })
}

function getPositiveHostedReviewLinkUpdateKey(
  updates: Partial<WorktreeMeta>
): HostedReviewLinkKey | null {
  for (const key of HOSTED_REVIEW_LINK_KEYS) {
    if (isPositiveHostedReviewNumber(updates[key])) {
      return key
    }
  }
  return null
}

function clearOlderHostedReviewLinksForReplacement(
  updates: Partial<WorktreeMeta>,
  existingWorktree: Worktree
): Partial<WorktreeMeta> {
  const replacementKey = getPositiveHostedReviewLinkUpdateKey(updates)
  if (!replacementKey) {
    return updates
  }
  let normalized = updates
  for (const key of HOSTED_REVIEW_LINK_KEYS) {
    if (key === replacementKey || existingWorktree[key] == null) {
      continue
    }
    // Why: one branch can only push to one hosted-review head; keeping older
    // provider links lets stale metadata win the target lookup after replacement.
    normalized = normalized === updates ? { ...updates } : normalized
    normalized[key] = null
  }
  return normalized
}

function getHostedReviewLinkForMetaRefresh(
  updates: Partial<WorktreeMeta>,
  existingWorktree: Worktree | undefined,
  key: HostedReviewLinkKey
): number | null {
  return Object.prototype.hasOwnProperty.call(updates, key)
    ? (updates[key] ?? null)
    : (existingWorktree?.[key] ?? null)
}

function hasExplicitPushTargetClear(updates: Partial<WorktreeMeta>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(updates, 'pushTarget') && updates.pushTarget === undefined
  )
}

type RuntimeWorktreeMetaUpdates = Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
  pushTarget?: GitPushTarget | null
}

function encodePushTargetClearForRuntimeRpc(
  updates: Partial<WorktreeMeta>
): RuntimeWorktreeMetaUpdates {
  if (!hasExplicitPushTargetClear(updates)) {
    return updates
  }
  // Why: remote runtime RPC is JSON-shaped and drops undefined fields, so use
  // null as the wire-only signal for clearing persisted pushTarget metadata.
  return { ...updates, pushTarget: null }
}

// Every worktree-id-keyed store map the rename path re-keys on a folder move, so a
// new `*ByWorktree` map is not silently missed when a worktree id changes. Maps keyed
// by tab id or file id are deliberately NOT here — tabs and files keep their ids across
// a worktree rename.
const WORKTREE_ID_KEYED_MAP_KEYS = [
  'worktreeLineageById',
  'tabsByWorktree',
  'deleteStateByWorktreeId',
  'baseStatusByWorktreeId',
  'remoteBranchConflictByWorktreeId',
  'fileSearchStateByWorktree',
  'browserTabsByWorktree',
  'recentlyClosedBrowserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'tabBarOrderByWorktree',
  'pendingReconnectTabByWorktree',
  'rightSidebarTabByWorktree',
  'rightSidebarExplorerViewByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'gitStatusByWorktree',
  'gitStatusHeadByWorktree',
  'gitIgnoredPathsByWorktree',
  'gitConflictOperationByWorktree',
  'trackedConflictPathsByWorktree',
  'gitBranchChangesByWorktree',
  'gitBranchCompareSummaryByWorktree',
  'gitBranchCompareRequestKeyByWorktree',
  'gitBranchCompareRequestStatusHeadByWorktree',
  'showDotfilesByWorktree',
  'expandedDirs',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof AppState)[]

/**
 * Re-key every worktree-id-keyed map (plus the Set, openFiles[].worktreeId, and
 * the active/renaming pointers) from `oldWorktreeId` to `newWorktreeId` after a
 * folder rename changed the worktree's path-derived id. Tab-id/file-id-keyed maps
 * and the activeFile/activeTab/activeBrowserTab pointers are untouched because
 * tabs and files keep their ids. No-op when nothing references the old id.
 *
 * Main-process counterpart: `Store.migrateWorktreeIdentity` in persistence.ts
 * re-keys the persisted worktree state for the same id change.
 */
function buildWorktreeRenameState(
  s: AppState,
  oldWorktreeId: string,
  newWorktreeId: string
): Partial<AppState> {
  if (oldWorktreeId === newWorktreeId) {
    return {}
  }
  const renamed: Record<string, unknown> = {}
  const renameKey = <T>(
    key: keyof AppState,
    mapValue: (value: T) => T = (value) => value
  ): void => {
    const map = s[key as keyof AppState] as Record<string, unknown> | undefined
    if (!map || !(oldWorktreeId in map)) {
      return
    }
    const next = { ...map }
    next[newWorktreeId] = mapValue(next[oldWorktreeId] as T)
    delete next[oldWorktreeId]
    renamed[key] = next
  }
  const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
  const renameValueByKey: Partial<Record<(typeof WORKTREE_ID_KEYED_MAP_KEYS)[number], unknown>> = {
    tabsByWorktree: (tabs: { worktreeId: string }[]) => tabs.map(withNewWorktreeId),
    browserTabsByWorktree: (workspaces: { worktreeId: string }[]) =>
      workspaces.map(withNewWorktreeId),
    recentlyClosedBrowserTabsByWorktree: (
      snapshots: { workspace: { worktreeId: string }; pages: { worktreeId: string }[] }[]
    ) =>
      snapshots.map((snapshot) => ({
        ...snapshot,
        workspace: withNewWorktreeId(snapshot.workspace),
        pages: snapshot.pages.map(withNewWorktreeId)
      })),
    unifiedTabsByWorktree: (tabs: { worktreeId: string }[]) => tabs.map(withNewWorktreeId),
    groupsByWorktree: (groups: { worktreeId: string }[]) => groups.map(withNewWorktreeId)
  }
  for (const key of WORKTREE_ID_KEYED_MAP_KEYS) {
    renameKey(key, renameValueByKey[key] as ((value: unknown) => unknown) | undefined)
  }
  // Re-key these on rename so a renamed worktree keeps its editor-undo + push/pull
  // state. (Both removal paths — buildWorktreePurgeState and the single
  // removeWorktree reducer — now also purge them on removal.)
  renameKey('recentlyClosedEditorTabsByWorktree', (files: { worktreeId: string }[]) =>
    files.map(withNewWorktreeId)
  )
  renameKey('remoteStatusesByWorktree')

  const openFiles = s.openFiles?.some((f) => f.worktreeId === oldWorktreeId)
    ? s.openFiles.map((f) =>
        f.worktreeId === oldWorktreeId ? { ...f, worktreeId: newWorktreeId } : f
      )
    : s.openFiles
  const currentBrowserPagesByWorkspace = s.browserPagesByWorkspace ?? {}
  const browserPagesByWorkspace = Object.values(currentBrowserPagesByWorkspace).some((pages) =>
    pages.some((page) => page.worktreeId === oldWorktreeId)
  )
    ? Object.fromEntries(
        Object.entries(currentBrowserPagesByWorkspace).map(([workspaceId, pages]) => [
          workspaceId,
          pages.map(withNewWorktreeId)
        ])
      )
    : s.browserPagesByWorkspace
  const currentRecentlyClosedBrowserPagesByWorkspace = s.recentlyClosedBrowserPagesByWorkspace ?? {}
  const recentlyClosedBrowserPagesByWorkspace = Object.values(
    currentRecentlyClosedBrowserPagesByWorkspace
  ).some((pages) => pages.some((page) => page.worktreeId === oldWorktreeId))
    ? Object.fromEntries(
        Object.entries(currentRecentlyClosedBrowserPagesByWorkspace).map(([workspaceId, pages]) => [
          workspaceId,
          pages.map(withNewWorktreeId)
        ])
      )
    : s.recentlyClosedBrowserPagesByWorkspace
  let everActivated = s.everActivatedWorktreeIds
  if (everActivated.has(oldWorktreeId)) {
    everActivated = new Set(everActivated)
    everActivated.delete(oldWorktreeId)
    everActivated.add(newWorktreeId)
  }
  const pendingReconnectWorktreeIds = s.pendingReconnectWorktreeIds?.includes(oldWorktreeId)
    ? s.pendingReconnectWorktreeIds.map((id) => (id === oldWorktreeId ? newWorktreeId : id))
    : s.pendingReconnectWorktreeIds
  const currentSleepingAgentSessionsByPaneKey = s.sleepingAgentSessionsByPaneKey ?? {}
  const sleepingAgentSessionsByPaneKey = Object.values(currentSleepingAgentSessionsByPaneKey).some(
    (record) => record.worktreeId === oldWorktreeId
  )
    ? Object.fromEntries(
        Object.entries(currentSleepingAgentSessionsByPaneKey).map(([paneKey, record]) => [
          paneKey,
          record.worktreeId === oldWorktreeId ? { ...record, worktreeId: newWorktreeId } : record
        ])
      )
    : s.sleepingAgentSessionsByPaneKey

  return {
    ...(renamed as Partial<AppState>),
    ...(openFiles !== s.openFiles ? { openFiles } : {}),
    ...(browserPagesByWorkspace !== s.browserPagesByWorkspace ? { browserPagesByWorkspace } : {}),
    ...(recentlyClosedBrowserPagesByWorkspace !== s.recentlyClosedBrowserPagesByWorkspace
      ? { recentlyClosedBrowserPagesByWorkspace }
      : {}),
    ...(everActivated !== s.everActivatedWorktreeIds
      ? { everActivatedWorktreeIds: everActivated }
      : {}),
    ...(pendingReconnectWorktreeIds !== s.pendingReconnectWorktreeIds
      ? { pendingReconnectWorktreeIds }
      : {}),
    ...(sleepingAgentSessionsByPaneKey !== s.sleepingAgentSessionsByPaneKey
      ? { sleepingAgentSessionsByPaneKey }
      : {}),
    ...(s.activeWorktreeId === oldWorktreeId ? { activeWorktreeId: newWorktreeId } : {}),
    // The active workspace key derives from the worktree id, so keep it in sync when the active worktree is renamed.
    ...(s.activeWorkspaceKey === worktreeWorkspaceKey(oldWorktreeId)
      ? { activeWorkspaceKey: worktreeWorkspaceKey(newWorktreeId) }
      : {}),
    ...(s.renamingWorktreeId?.worktreeId === oldWorktreeId
      ? { renamingWorktreeId: { ...s.renamingWorktreeId, worktreeId: newWorktreeId } }
      : {})
  }
}

function buildWorktreePurgeState(s: AppState, worktreeIds: string[]): Partial<AppState> {
  const worktreeIdSet = new Set(worktreeIds)
  pruneHostedReviewLinkMutationGenerations(worktreeIdSet)

  // Collect every tab id (and removed file id) we are about to orphan.
  const doomedTabIds = new Set<string>()
  const doomedBrowserWorkspaceIds = new Set<string>()
  const doomedPageIds = new Set<string>()
  const removedFileIds = new Set<string>()
  for (const id of worktreeIdSet) {
    for (const tab of s.tabsByWorktree[id] ?? []) {
      doomedTabIds.add(tab.id)
      // Why: a removed worktree's panes are gone for good, so drop their
      // hibernation output epochs from that module-level map (mirrors the
      // hosted-review prune above). A future pane mints a fresh leafId at epoch 0.
      forgetAgentHibernationTabOutput(tab.id)
    }
    for (const workspace of s.browserTabsByWorktree[id] ?? []) {
      doomedBrowserWorkspaceIds.add(workspace.id)
    }
  }
  // Why: the per-page browser maps are keyed by page id, not worktree/workspace id.
  // Collect every page owned by a doomed workspace so this bulk purge can evict
  // them. (The single removeWorktree path clears these via closeBrowserTab, but the
  // authoritative-scan reconcile that also reaches this reducer does not.)
  for (const workspaceId of doomedBrowserWorkspaceIds) {
    for (const page of s.browserPagesByWorkspace[workspaceId] ?? []) {
      doomedPageIds.add(page.id)
    }
  }
  for (const file of s.openFiles) {
    if (worktreeIdSet.has(file.worktreeId)) {
      removedFileIds.add(file.id)
      if (file.markdownPreviewSourceFileId) {
        removedFileIds.add(file.markdownPreviewSourceFileId)
      }
    }
  }

  const omitByWorktree = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const id of worktreeIdSet) {
      if (id in out) {
        delete out[id]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitWorkspaceLineageByWorktree = (
    obj: Record<string, WorkspaceLineage>
  ): Record<string, WorkspaceLineage> => {
    let changed = false
    const out = { ...obj }
    for (const id of worktreeIdSet) {
      const childKey = isWorkspaceKey(id) ? id : worktreeWorkspaceKey(id)
      if (childKey in out) {
        delete out[childKey]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const pruneRightSidebarTabByWorktree = (): AppState['rightSidebarTabByWorktree'] => {
    const omitted = omitByWorktree(s.rightSidebarTabByWorktree)
    let changed = omitted !== s.rightSidebarTabByWorktree
    const out: AppState['rightSidebarTabByWorktree'] = {}
    for (const [id, tab] of Object.entries(omitted)) {
      if (
        tab === 'explorer' ||
        tab === 'vault' ||
        tab === 'workspaces' ||
        tab === 'source-control' ||
        tab === 'checks' ||
        tab === 'ports'
      ) {
        out[id] = tab
      } else {
        changed = true
      }
    }
    return changed ? out : omitted
  }
  const omitByTabId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const tabId of doomedTabIds) {
      if (tabId in out) {
        delete out[tabId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByBrowserWorkspaceId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const workspaceId of doomedBrowserWorkspaceIds) {
      if (workspaceId in out) {
        delete out[workspaceId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByPageId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const pageId of doomedPageIds) {
      if (pageId in out) {
        delete out[pageId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByFileId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const fileId of removedFileIds) {
      if (fileId in out) {
        delete out[fileId]
        changed = true
      }
    }
    return changed ? out : obj
  }

  const nextOpenFiles = s.openFiles.some((f) => worktreeIdSet.has(f.worktreeId))
    ? s.openFiles.filter((f) => !worktreeIdSet.has(f.worktreeId))
    : s.openFiles

  const removedActive = s.activeWorktreeId != null && worktreeIdSet.has(s.activeWorktreeId)
  const activeFileCleared = s.activeFileId != null && removedFileIds.has(s.activeFileId)
  const activeTabCleared = s.activeTabId != null && doomedTabIds.has(s.activeTabId)

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

  return {
    // Worktree-scoped terminal/tab state
    worktreeLineageById: omitByWorktree(s.worktreeLineageById),
    workspaceLineageByChildKey: omitWorkspaceLineageByWorktree(s.workspaceLineageByChildKey),
    tabsByWorktree: omitByWorktree(s.tabsByWorktree),
    terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
    ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
    runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
    // Delete state
    deleteStateByWorktreeId: omitByWorktree(s.deleteStateByWorktreeId),
    baseStatusByWorktreeId: omitByWorktree(s.baseStatusByWorktreeId),
    remoteBranchConflictByWorktreeId: omitByWorktree(s.remoteBranchConflictByWorktreeId),
    // File search
    fileSearchStateByWorktree: omitByWorktree(s.fileSearchStateByWorktree),
    // Browser state
    browserTabsByWorktree: omitByWorktree(s.browserTabsByWorktree),
    browserPagesByWorkspace: omitByBrowserWorkspaceId(s.browserPagesByWorkspace),
    recentlyClosedBrowserTabsByWorktree: omitByWorktree(s.recentlyClosedBrowserTabsByWorktree),
    activeBrowserTabIdByWorktree: omitByWorktree(s.activeBrowserTabIdByWorktree),
    // Why: these browser maps are keyed by page/workspace id and were only cleaned
    // on the single-worktree removal path (closeBrowserTab); this bulk reconcile path
    // missed them, orphaning an annotation/handle/focus/closed-page entry per page of
    // every externally-removed worktree for the session.
    browserAnnotationsByPageId: omitByPageId(s.browserAnnotationsByPageId),
    remoteBrowserPageHandlesByPageId: omitByPageId(s.remoteBrowserPageHandlesByPageId),
    pendingAddressBarFocusByPageId: omitByPageId(s.pendingAddressBarFocusByPageId),
    // createBrowserTab writes both the workspace id and the page id into this map.
    pendingAddressBarFocusByTabId: omitByPageId(
      omitByBrowserWorkspaceId(s.pendingAddressBarFocusByTabId)
    ),
    recentlyClosedBrowserPagesByWorkspace: omitByBrowserWorkspaceId(
      s.recentlyClosedBrowserPagesByWorkspace
    ),
    // Editor state
    activeFileIdByWorktree: omitByWorktree(s.activeFileIdByWorktree),
    activeTabTypeByWorktree: omitByWorktree(s.activeTabTypeByWorktree),
    activeTabIdByWorktree: omitByWorktree(s.activeTabIdByWorktree),
    tabBarOrderByWorktree: omitByWorktree(s.tabBarOrderByWorktree),
    pendingReconnectTabByWorktree: omitByWorktree(s.pendingReconnectTabByWorktree),
    rightSidebarTabByWorktree: pruneRightSidebarTabByWorktree(),
    rightSidebarExplorerViewByWorktree: omitByWorktree(s.rightSidebarExplorerViewByWorktree ?? {}),
    // Split-tab / unified tab state
    unifiedTabsByWorktree: omitByWorktree(s.unifiedTabsByWorktree),
    groupsByWorktree: omitByWorktree(s.groupsByWorktree),
    layoutByWorktree: omitByWorktree(s.layoutByWorktree),
    activeGroupIdByWorktree: omitByWorktree(s.activeGroupIdByWorktree),
    // Git status caches
    gitStatusByWorktree: omitByWorktree(s.gitStatusByWorktree),
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal
    // paths, leaking an upstream-status entry per removed worktree.
    remoteStatusesByWorktree: omitByWorktree(s.remoteStatusesByWorktree),
    gitStatusHeadByWorktree: omitByWorktree(s.gitStatusHeadByWorktree),
    gitIgnoredPathsByWorktree: omitByWorktree(s.gitIgnoredPathsByWorktree),
    gitConflictOperationByWorktree: omitByWorktree(s.gitConflictOperationByWorktree),
    trackedConflictPathsByWorktree: omitByWorktree(s.trackedConflictPathsByWorktree),
    gitBranchChangesByWorktree: omitByWorktree(s.gitBranchChangesByWorktree),
    gitBranchCompareSummaryByWorktree: omitByWorktree(s.gitBranchCompareSummaryByWorktree),
    gitBranchCompareRequestKeyByWorktree: omitByWorktree(s.gitBranchCompareRequestKeyByWorktree),
    gitBranchCompareRequestStatusHeadByWorktree: omitByWorktree(
      s.gitBranchCompareRequestStatusHeadByWorktree
    ),
    // Why: keyed by worktreeId; without this it leaks a huge-status marker per
    // removed worktree for the rest of the session.
    gitStatusHugeByWorktree: omitByWorktree(s.gitStatusHugeByWorktree),
    showDotfilesByWorktree: omitByWorktree(s.showDotfilesByWorktree),
    expandedDirs: omitByWorktree(s.expandedDirs),
    // Per-file editor state for removed files
    editorDrafts: omitByFileId(s.editorDrafts),
    markdownViewMode: omitByFileId(s.markdownViewMode),
    markdownFrontmatterVisible: omitByFileId(s.markdownFrontmatterVisible),
    // Why: keyed by fileId; the bulk reconcile path previously kept these,
    // leaking a cursor-line / view-mode entry per file of every removed worktree.
    editorCursorLine: omitByFileId(s.editorCursorLine),
    editorViewMode: omitByFileId(s.editorViewMode),
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal
    // paths, leaking the per-worktree editor-undo (Cmd/Ctrl+Shift+T) snapshots.
    recentlyClosedEditorTabsByWorktree: omitByWorktree(s.recentlyClosedEditorTabsByWorktree),
    // Top-level actives
    openFiles: nextOpenFiles,
    everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
    lastVisitedAtByWorktreeId: omitByWorktree(s.lastVisitedAtByWorktreeId),
    // Why: keyed by worktreeId; the write-once default-terminal idempotency guard
    // was re-keyed on rename but missed by both removal paths.
    defaultTerminalTabsAppliedByWorktreeId: omitByWorktree(
      s.defaultTerminalTabsAppliedByWorktreeId
    ),
    activeWorktreeId: removedActive ? null : s.activeWorktreeId,
    activeWorkspaceKey: (() => {
      if (s.activeWorkspaceKey && worktreeIdSet.has(s.activeWorkspaceKey)) {
        return null
      }
      const activeScope = s.activeWorkspaceKey ? parseWorkspaceKey(s.activeWorkspaceKey) : null
      return activeScope?.type === 'worktree' && worktreeIdSet.has(activeScope.worktreeId)
        ? null
        : s.activeWorkspaceKey
    })(),
    activeFileId: activeFileCleared ? null : s.activeFileId,
    activeBrowserTabId: removedActive ? null : s.activeBrowserTabId,
    activeTabId: activeTabCleared ? null : s.activeTabId,
    activeTabType: removedActive || activeFileCleared ? 'terminal' : s.activeTabType
  }
}

export const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  detectedWorktreesByRepo: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  activeWorktreeId: null,
  activeWorkspaceKey: null,
  pendingWorktreeCreations: {},
  activePendingCreationId: null,
  renamingWorktreeId: null,
  deleteStateByWorktreeId: {},
  baseStatusByWorktreeId: {},
  remoteBranchConflictByWorktreeId: {},
  sortEpoch: 0,
  everActivatedWorktreeIds: new Set<string>(),
  lastVisitedAtByWorktreeId: {},
  hasHydratedWorktreePurge: false,

  fetchDetectedWorktrees: async (repoId) => {
    try {
      const ownerState = get()
      const hostId = repoHostId(ownerState, repoId)
      const result = await listDetectedWorktreesForRepoCoalesced(
        settingsForRepoOwner(ownerState, repoId, hostId),
        repoId,
        { executionHostId: hostId }
      )
      set((s) => {
        // Why: detected-only refreshes can overlap host-scoped visible refreshes;
        // keep detected state stamped/merged so SSH/runtime rows are not clobbered.
        const mergedDetected = mergeDetectedWorktreesForHost(
          s.detectedWorktreesByRepo[repoId],
          result,
          hostId,
          worktreeHostMatchOptions(s, repoId, hostId)
        )
        return areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[repoId], mergedDetected)
          ? s
          : { detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [repoId]: mergedDetected } }
      })
      return result
    } catch (err) {
      console.error(`Failed to fetch detected worktrees for repo ${repoId}:`, err)
      return null
    }
  },

  fetchWorktrees: async (repoId, options) => {
    try {
      const ownerState = get()
      const hostId = repoHostId(ownerState, repoId)
      const settings = settingsForRepoOwner(ownerState, repoId, hostId)
      const detected = await listDetectedWorktreesForRepoCoalesced(settings, repoId, {
        executionHostId: hostId,
        requireAuthoritative: options?.requireAuthoritative
      })
      if (options?.requireAuthoritative && !detected.authoritative) {
        return false
      }
      const current = get().worktreesByRepo[repoId]
      const worktrees = sanitizeHostedReviewLinksForBranchClears(
        toVisibleWorktrees(detected, hostId),
        current
      )
      const currentMatchOptions = worktreeHostMatchOptions(get(), repoId, hostId)
      const currentForHost = (current ?? []).filter((worktree) =>
        worktreeMatchesHost(worktree, hostId, currentMatchOptions)
      )
      if (areWorktreesEqual(currentForHost, worktrees)) {
        set((s) => {
          const matchOptions = worktreeHostMatchOptions(s, repoId, hostId)
          const removedIds = getRemovedWorktreeIdsAfterAuthoritativeScan(
            s,
            repoId,
            detected,
            hostId
          )
          const mergedDetected = mergeDetectedWorktreesForHost(
            s.detectedWorktreesByRepo[repoId],
            detected,
            hostId,
            matchOptions
          )
          const mergedWorktrees = mergeWorktreesForHost(
            s.worktreesByRepo[repoId],
            worktrees,
            hostId,
            matchOptions
          )
          const worktreesChanged = !areWorktreesEqual(s.worktreesByRepo[repoId], mergedWorktrees)
          if (
            !worktreesChanged &&
            areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[repoId], mergedDetected) &&
            removedIds.length === 0
          ) {
            return s
          }
          return {
            worktreesByRepo: {
              ...s.worktreesByRepo,
              [repoId]: mergedWorktrees
            },
            detectedWorktreesByRepo: {
              ...s.detectedWorktreesByRepo,
              [repoId]: mergedDetected
            },
            ...(worktreesChanged ? { sortEpoch: s.sortEpoch + 1 } : {}),
            ...(removedIds.length > 0 ? buildWorktreePurgeState(s, removedIds) : {})
          }
        })
        await refreshRemoteWorktreeLineageBestEffort(settings, set)
        return detected.authoritative
      }

      // Why: `git worktree list` can fail transiently (e.g. concurrent git
      // operations holding a lock, disk I/O hiccup). The backend catches these
      // errors and returns []. Replacing a known-good worktree list with []
      // causes tabsByWorktree entries to become orphaned — the agent activity
      // badge then shows raw worktree IDs instead of display names, and click-
      // to-navigate silently fails because findWorktreeById returns undefined.
      // Keep the stale-but-correct data until the next successful refresh.
      if (!detected.authoritative && worktrees.length === 0 && currentForHost.length > 0) {
        set((s) => ({
          detectedWorktreesByRepo: {
            ...s.detectedWorktreesByRepo,
            [repoId]: mergeDetectedWorktreesForHost(
              s.detectedWorktreesByRepo[repoId],
              detected,
              hostId,
              worktreeHostMatchOptions(s, repoId, hostId)
            )
          }
        }))
        return false
      }

      set((s) => {
        // Why: hidden worktrees are not in worktreesByRepo. Purge decisions
        // must diff against the previous authoritative detected list so hiding
        // does not delete state, and deleting a hidden worktree still does.
        const matchOptions = worktreeHostMatchOptions(s, repoId, hostId)
        const removedIds = getRemovedWorktreeIdsAfterAuthoritativeScan(s, repoId, detected, hostId)
        const mergedWorktrees = mergeWorktreesForHost(
          s.worktreesByRepo[repoId],
          worktrees,
          hostId,
          matchOptions
        )
        const mergedDetected = mergeDetectedWorktreesForHost(
          s.detectedWorktreesByRepo[repoId],
          detected,
          hostId,
          matchOptions
        )

        return {
          // Why: active worktrees can change branches entirely from a terminal.
          // We refresh that live git identity into renderer state, but only bump
          // sortEpoch when git actually reports a different worktree payload.
          worktreesByRepo: { ...s.worktreesByRepo, [repoId]: mergedWorktrees },
          detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [repoId]: mergedDetected },
          sortEpoch: s.sortEpoch + 1,
          ...(removedIds.length > 0 ? buildWorktreePurgeState(s, removedIds) : {})
        }
      })
      await refreshRemoteWorktreeLineageBestEffort(settings, set)
      return detected.authoritative
    } catch (err) {
      console.error(`Failed to fetch worktrees for repo ${repoId}:`, err)
      return false
    }
  },

  fetchAllWorktrees: async () => {
    const { repos } = get()

    // Why: once the one-shot hydration-time purge has fired, subsequent
    // calls just need to refresh each repo's cached list. No need to
    // double-probe the IPC for the per-repo success signal.
    if (get().hasHydratedWorktreePurge) {
      await mapReposForWorktreeRefresh(repos, async (r) => {
        const hostId = getRepoExecutionHostId(r)
        const settings = settingsForKnownRepoOwner(get().settings, r)
        const detected = await listDetectedWorktreesForRepoCoalesced(settings, r.id, {
          executionHostId: hostId
        })
        const worktrees = sanitizeHostedReviewLinksForBranchClears(
          toVisibleWorktrees(detected, hostId),
          get().worktreesByRepo[r.id]
        )
        set((s) => {
          const matchOptions = worktreeHostMatchOptions(s, r.id, hostId)
          const removedIds = getRemovedWorktreeIdsAfterAuthoritativeScan(s, r.id, detected, hostId)
          const mergedWorktrees = mergeWorktreesForHost(
            s.worktreesByRepo[r.id],
            worktrees,
            hostId,
            matchOptions
          )
          const mergedDetected = mergeDetectedWorktreesForHost(
            s.detectedWorktreesByRepo[r.id],
            detected,
            hostId,
            matchOptions
          )
          if (
            areWorktreesEqual(s.worktreesByRepo[r.id], mergedWorktrees) &&
            areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[r.id], mergedDetected) &&
            removedIds.length === 0
          ) {
            return s
          }
          return {
            worktreesByRepo: { ...s.worktreesByRepo, [r.id]: mergedWorktrees },
            detectedWorktreesByRepo: { ...s.detectedWorktreesByRepo, [r.id]: mergedDetected },
            sortEpoch: s.sortEpoch + 1,
            ...(removedIds.length > 0 ? buildWorktreePurgeState(s, removedIds) : {})
          }
        })
      })
      return
    }

    // Why: users upgrading from a pre-fix build may have persisted
    // tabsByWorktree entries for worktrees that were deleted in the previous
    // session. Without the hydration-time purge below those entries would
    // keep zombie PTYs misclassified as "bound" in SessionsStatusSegment
    // (design §2c), which means the user would still need a second restart
    // post-upgrade to reclaim memory.
    //
    // Safety gate: fetchWorktrees swallows IPC errors and short-circuits on
    // empty-replace when cached data exists. Neither signal bubbles up to the
    // caller, so we probe the IPC directly to get the per-repo success signal,
    // then apply that same payload to state instead of listing each repo again.
    const results = await mapReposForWorktreeRefresh(
      repos,
      async (
        r
      ): Promise<
        | { repoId: string; ok: boolean; detected: DetectedWorktreeListResult }
        | { repoId: string; ok: false }
      > => {
        try {
          const hostId = getRepoExecutionHostId(r)
          const detected = await listDetectedWorktreesForRepoCoalesced(
            settingsForKnownRepoOwner(get().settings, r),
            r.id,
            { executionHostId: hostId }
          )
          const current = get().worktreesByRepo[r.id]
          const list = sanitizeHostedReviewLinksForBranchClears(
            toVisibleWorktrees(detected, hostId),
            current
          )
          const currentMatchOptions = worktreeHostMatchOptions(get(), r.id, hostId)
          const currentForHost = (current ?? []).filter((worktree) =>
            worktreeMatchesHost(worktree, hostId, currentMatchOptions)
          )
          if (
            !areWorktreesEqual(currentForHost, list) &&
            !(list.length === 0 && currentForHost.length > 0 && !detected.authoritative)
          ) {
            set((s) => {
              const matchOptions = worktreeHostMatchOptions(s, r.id, hostId)
              return {
                worktreesByRepo: {
                  ...s.worktreesByRepo,
                  [r.id]: mergeWorktreesForHost(s.worktreesByRepo[r.id], list, hostId, matchOptions)
                },
                detectedWorktreesByRepo: {
                  ...s.detectedWorktreesByRepo,
                  [r.id]: mergeDetectedWorktreesForHost(
                    s.detectedWorktreesByRepo[r.id],
                    detected,
                    hostId,
                    matchOptions
                  )
                },
                sortEpoch: s.sortEpoch + 1
              }
            })
          } else {
            set((s) => ({
              detectedWorktreesByRepo: {
                ...s.detectedWorktreesByRepo,
                [r.id]: mergeDetectedWorktreesForHost(
                  s.detectedWorktreesByRepo[r.id],
                  detected,
                  hostId,
                  worktreeHostMatchOptions(s, r.id, hostId)
                )
              }
            }))
          }
          return { repoId: r.id, ok: detected.authoritative, detected }
        } catch (err) {
          console.error(`Failed to fetch worktrees for repo ${r.id}:`, err)
          return { repoId: r.id, ok: false as const }
        }
      }
    )

    const hasAnyDetectedWorktree = results.some(
      (result) => 'detected' in result && result.ok && result.detected.worktrees.length > 0
    )
    const allSucceeded = results.length > 0 && results.every((r) => r.ok) && hasAnyDetectedWorktree
    if (!allSucceeded) {
      // Defer; try again on the next fetchAllWorktrees call.
      return
    }
    const validIds = new Set<string>()
    // Why: floating is persisted renderer state, but not a repo worktree that
    // authoritative runtime scans can return.
    validIds.add(FLOATING_TERMINAL_WORKTREE_ID)
    for (const result of Object.values(get().detectedWorktreesByRepo)) {
      if (!result.authoritative) {
        continue
      }
      for (const w of result.worktrees) {
        validIds.add(w.id)
      }
    }
    const stale = Object.keys(get().tabsByWorktree).filter((id) => !validIds.has(id))
    if (stale.length > 0) {
      console.warn(
        `[worktree-purge] hydration-time purge removing stale state for ${stale.length} worktree(s):`,
        stale
      )
      get().purgeWorktreeTerminalState(stale)
    }
    set({ hasHydratedWorktreePurge: true })
  },

  fetchWorktreeLineage: async () => {
    try {
      // Why: lineage is a focused-host refresh — fetch from the focused host and
      // host-merge so other hosts' previously fetched lineage is preserved.
      await refreshWorktreeLineageForSettings(get().settings, set)
    } catch (err) {
      console.error('Failed to fetch worktree lineage:', err)
    }
  },

  updateWorktreeLineage: async (worktreeId, args) => {
    const ownerSettings = settingsForWorktreeOwner(get(), worktreeId)
    try {
      applyWorktreeLineageUpdate(
        set,
        worktreeId,
        await setWorktreeLineageForRuntime(ownerSettings, worktreeId, args)
      )
    } catch (err) {
      console.error('Failed to update worktree lineage:', err)
      await refreshWorktreeLineageForSettings(ownerSettings, set)
    }
  },

  assignWorktreeParent: async (worktreeId, args) => {
    const ownerSettings = settingsForWorktreeOwner(get(), worktreeId)
    try {
      applyWorktreeLineageUpdate(
        set,
        worktreeId,
        await setWorktreeLineageForRuntime(ownerSettings, worktreeId, args)
      )
    } catch (err) {
      console.error('Failed to assign worktree parent:', err)
      await refreshWorktreeLineageForSettings(ownerSettings, set)
      throw err
    }
  },

  updateWorktreeGitIdentity: (worktreeId, identity) => {
    let shouldPersistHostedReviewClear = false
    let clearedBranch: string | null = null
    let clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const existing = get().worktreesByRepo[repoId]?.find((worktree) => worktree.id === worktreeId)
    if (!existing) {
      return
    }
    const expectedHead = identity.head ?? existing.head
    const expectedBranch = identity.branch === null ? '' : (identity.branch ?? existing.branch)
    if (expectedHead === existing.head && expectedBranch === existing.branch) {
      return
    }

    set((s) => {
      const current = s.worktreesByRepo[repoId]
      if (!current) {
        return s
      }

      let changed = false
      const next = current.map((worktree) => {
        if (worktree.id !== worktreeId) {
          return worktree
        }
        const nextHead = identity.head ?? worktree.head
        const nextBranch = identity.branch === null ? '' : (identity.branch ?? worktree.branch)
        if (nextHead === worktree.head && nextBranch === worktree.branch) {
          return worktree
        }
        changed = true
        const hostedReviewBranchChanged =
          canonicalHostedReviewBranchIdentity(nextBranch) !==
          canonicalHostedReviewBranchIdentity(worktree.branch)
        const shouldClearHostedReviewContext =
          hostedReviewBranchChanged && hasBranchScopedHostedReviewContext(worktree)
        if (shouldClearHostedReviewContext) {
          shouldPersistHostedReviewClear = true
          clearedBranch = nextBranch
          clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
          rememberHostedReviewLinkClear(worktreeId, nextBranch, clearGeneration, nextHead)
        } else {
          const tombstone = hostedReviewLinkClearTombstonesByWorktreeId.get(worktreeId)
          if (tombstone) {
            const nextBranchIdentity = canonicalHostedReviewBranchIdentity(nextBranch)
            hostedReviewLinkClearTombstonesByWorktreeId.set(worktreeId, {
              ...tombstone,
              branch: nextBranch,
              branchIdentity: nextBranchIdentity,
              head: nextHead
            })
            if (hostedReviewBranchChanged) {
              shouldPersistHostedReviewClear = true
              clearedBranch = nextBranch
              clearGeneration = tombstone.generation
            }
          }
        }
        // Why: terminal branch switches only patch branch/head here; auto-derived
        // titles need the same branch derivation that full worktree listing uses.
        const currentBranchName = branchName(worktree.branch)
        const wasAutoDerived = worktree.displayName === currentBranchName
        const wasDetachedAutoDerived =
          worktree.branch === '' &&
          nextBranch !== '' &&
          detachedHeadAutoDerivedDisplayNames.get(worktreeId) === worktree.displayName
        const nextDisplayName =
          (wasAutoDerived || wasDetachedAutoDerived) && nextBranch
            ? branchName(nextBranch)
            : worktree.displayName
        if (identity.branch === null && wasAutoDerived) {
          detachedHeadAutoDerivedDisplayNames.set(worktreeId, worktree.displayName)
        } else if (identity.branch !== undefined) {
          detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
        }
        return {
          ...worktree,
          head: nextHead,
          branch: nextBranch,
          displayName: nextDisplayName,
          // Why: linked reviews are branch-scoped hints. If a terminal switches
          // branches, keeping the old exact link makes Checks refresh the old PR.
          ...(shouldClearHostedReviewContext ? CLEARED_HOSTED_REVIEW_LINK_UPDATES : {})
        }
      })

      if (!changed) {
        return s
      }

      return {
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: next },
        sortEpoch: s.sortEpoch + 1
      }
    })
    if (!shouldPersistHostedReviewClear || clearedBranch === null) {
      return
    }

    void Promise.resolve()
      .then(async () => {
        let currentWorktreeId = resolveHostedReviewLinkWorktreeId(worktreeId)
        const persistedWorktreeIds = new Set<string>()
        while (true) {
          currentWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (persistedWorktreeIds.has(currentWorktreeId)) {
            return
          }
          persistedWorktreeIds.add(currentWorktreeId)
          let current = get().getKnownWorktreeById(currentWorktreeId)
          if (
            !current ||
            current.branch !== clearedBranch ||
            getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration
          ) {
            return
          }
          if (!hostedReviewLinksAreCleared(current as Worktree)) {
            // Why: a worktree refetch can rehydrate stale linked-review metadata
            // before this async clear starts; clear it again instead of bailing out.
            applyHostedReviewLinkClear(set, currentWorktreeId)
            current = get().getKnownWorktreeById(currentWorktreeId)
            if (!current || current.branch !== clearedBranch) {
              return
            }
          }
          await persistWorktreeMeta(
            settingsForWorktreeOwner(get(), currentWorktreeId),
            currentWorktreeId,
            CLEARED_HOSTED_REVIEW_LINK_UPDATES
          )
          const migratedWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (migratedWorktreeId === currentWorktreeId) {
            break
          }
          // Why: worktree creation can migrate ids while this IPC is in flight;
          // persist the branch-scoped clear under the new durable id as well.
          currentWorktreeId = migratedWorktreeId
        }
        const latest = get().getKnownWorktreeById(currentWorktreeId)
        if (
          !latest ||
          latest.branch !== clearedBranch ||
          hostedReviewLinksAreCleared(latest as Worktree)
        ) {
          return
        }
        if (getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration) {
          // Why: a delayed branch-switch clear must not win over a newer manual relink.
          await persistWorktreeMeta(
            settingsForWorktreeOwner(get(), currentWorktreeId),
            currentWorktreeId,
            getHostedReviewLinkUpdates(latest as Worktree)
          )
          return
        }
        // Why: a worktree refetch can briefly rehydrate old metadata before
        // the branch-switch clear reaches disk; do not write that stale link back.
        applyHostedReviewLinkClear(set, currentWorktreeId)
      })
      .catch((err) => {
        if (isRuntimeSelectorNotFoundError(err)) {
          void get().fetchWorktrees(
            getRepoIdFromWorktreeId(resolveHostedReviewLinkWorktreeId(worktreeId))
          )
          return
        }
        console.error('Failed to persist branch-scoped review link clear:', err)
      })
  },

  updateWorktreeBaseStatus: (event) => {
    set((s) => ({
      baseStatusByWorktreeId: {
        ...s.baseStatusByWorktreeId,
        [event.worktreeId]: event
      }
    }))
  },

  updateWorktreeRemoteBranchConflict: (event) => {
    set((s) => ({
      remoteBranchConflictByWorktreeId: {
        ...s.remoteBranchConflictByWorktreeId,
        [event.worktreeId]: event
      }
    }))
  },

  prefetchWorktreeCreateBase: async (repoId, baseBranch) => {
    try {
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
      if (target.kind === 'local') {
        await window.api.worktrees.prefetchCreateBase({
          repoId,
          ...(baseBranch ? { baseBranch } : {})
        })
        return
      }
      await callRuntimeRpc(
        target,
        'worktree.prefetchCreateBase',
        { repo: repoId, ...(baseBranch ? { baseBranch } : {}) },
        { timeoutMs: 30_000 }
      )
    } catch {
      // Why: prefetch is only a latency hedge. The create path awaits the same
      // backend refresh and owns user-visible error reporting.
    }
  },

  createWorktree: async (
    repoId,
    name,
    baseBranch,
    setupDecision = 'inherit',
    sparseCheckout,
    telemetrySource,
    displayName,
    linkedIssue,
    linkedPR,
    pushTarget,
    createdWithAgent,
    linkedLinearIssue,
    branchNameOverride,
    workspaceStatus,
    linkedGitLabMR,
    linkedGitLabIssue,
    startup,
    pendingFirstAgentMessageRename,
    creationId,
    linkedLinearIssueWorkspaceId,
    linkedLinearIssueOrganizationUrlKey,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    compareBaseRef,
    options
  ) => {
    const automationProvenanceRequest = options?.automationProvenanceRequest
    const retryableConflictPatterns = [
      /already exists locally/i,
      /already exists on a remote/i,
      /^Branch ".+" already exists\./i,
      /already has pr #\d+/i
    ]
    const nextCandidateName = (current: string, attempt: number): string =>
      attempt === 0 ? current : `${current}-${attempt + 1}`
    const isBranchNameOverrideConflict = (error: Error): boolean =>
      Boolean(
        branchNameOverride &&
        (/^Branch ".+" already exists\./i.test(error.message) ||
          /already exists locally/i.test(error.message) ||
          /already exists on a remote/i.test(error.message) ||
          /already has pr #\d+/i.test(error.message))
      )

    try {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const candidateName = nextCandidateName(name, attempt)
        try {
          // Why: Manual sort is user-authored order. Stamp new workspaces
          // deliberately at the top instead of relying on sortOrder fallback.
          const manualOrder = get().sortBy === 'manual' ? Date.now() : undefined
          const activeScope = parseWorkspaceKey(get().activeWorkspaceKey ?? '')
          const parentWorkspace =
            activeScope?.type === 'folder'
              ? folderWorkspaceKey(activeScope.folderWorkspaceId)
              : undefined
          const createArgs = {
            repoId,
            name: candidateName,
            baseBranch,
            ...(compareBaseRef ? { compareBaseRef } : {}),
            ...(branchNameOverride ? { branchNameOverride } : {}),
            setupDecision,
            sparseCheckout,
            ...(displayName ? { displayName } : {}),
            ...(telemetrySource ? { telemetrySource } : {}),
            ...(linkedIssue !== undefined ? { linkedIssue } : {}),
            ...(linkedPR !== undefined ? { linkedPR } : {}),
            ...(pushTarget ? { pushTarget } : {}),
            ...(createdWithAgent ? { createdWithAgent } : {}),
            ...(pendingFirstAgentMessageRename === true && createdWithAgent
              ? { pendingFirstAgentMessageRename: true }
              : {}),
            ...(linkedLinearIssue !== undefined ? { linkedLinearIssue } : {}),
            ...(linkedLinearIssueWorkspaceId !== undefined ? { linkedLinearIssueWorkspaceId } : {}),
            ...(linkedLinearIssueOrganizationUrlKey !== undefined
              ? { linkedLinearIssueOrganizationUrlKey }
              : {}),
            ...(manualOrder !== undefined ? { manualOrder } : {}),
            ...(parentWorkspace ? { parentWorkspace } : {}),
            ...(workspaceStatus !== undefined ? { workspaceStatus } : {}),
            ...(linkedGitLabMR !== undefined ? { linkedGitLabMR } : {}),
            ...(linkedGitLabIssue !== undefined ? { linkedGitLabIssue } : {}),
            ...(linkedBitbucketPR !== undefined ? { linkedBitbucketPR } : {}),
            ...(linkedAzureDevOpsPR !== undefined ? { linkedAzureDevOpsPR } : {}),
            ...(linkedGiteaPR !== undefined ? { linkedGiteaPR } : {}),
            ...(startup ? { startup } : {}),
            ...(creationId ? { creationId } : {}),
            ...(automationProvenanceRequest ? { automationProvenanceRequest } : {})
          }
          const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
          const result =
            target.kind === 'local'
              ? await window.api.worktrees.create(createArgs)
              : await callRuntimeRpc<Awaited<ReturnType<typeof window.api.worktrees.create>>>(
                  target,
                  'worktree.create',
                  {
                    repo: repoId,
                    name: candidateName,
                    baseBranch,
                    ...(compareBaseRef ? { compareBaseRef } : {}),
                    ...(branchNameOverride ? { branchNameOverride } : {}),
                    setupDecision,
                    sparseCheckout,
                    ...(displayName ? { displayName } : {}),
                    ...(telemetrySource ? { telemetrySource } : {}),
                    ...(linkedIssue !== undefined ? { linkedIssue } : {}),
                    ...(linkedPR !== undefined ? { linkedPR } : {}),
                    ...(pushTarget ? { pushTarget } : {}),
                    ...(createdWithAgent ? { createdWithAgent } : {}),
                    ...(pendingFirstAgentMessageRename === true && createdWithAgent
                      ? { pendingFirstAgentMessageRename: true }
                      : {}),
                    ...(linkedLinearIssue !== undefined ? { linkedLinearIssue } : {}),
                    ...(linkedLinearIssueWorkspaceId !== undefined
                      ? { linkedLinearIssueWorkspaceId }
                      : {}),
                    ...(linkedLinearIssueOrganizationUrlKey !== undefined
                      ? { linkedLinearIssueOrganizationUrlKey }
                      : {}),
                    ...(manualOrder !== undefined ? { manualOrder } : {}),
                    ...(parentWorkspace ? { parentWorkspace } : {}),
                    ...(workspaceStatus !== undefined ? { workspaceStatus } : {}),
                    ...(linkedGitLabMR !== undefined ? { linkedGitLabMR } : {}),
                    ...(linkedGitLabIssue !== undefined ? { linkedGitLabIssue } : {}),
                    ...(linkedBitbucketPR !== undefined ? { linkedBitbucketPR } : {}),
                    ...(linkedAzureDevOpsPR !== undefined ? { linkedAzureDevOpsPR } : {}),
                    ...(linkedGiteaPR !== undefined ? { linkedGiteaPR } : {}),
                    ...(automationProvenanceRequest ? { automationProvenanceRequest } : {}),
                    ...(startup
                      ? {
                          startupCommand: startup.command,
                          ...(startup.env ? { startupEnv: startup.env } : {}),
                          ...(startup.launchConfig
                            ? { startupLaunchConfig: startup.launchConfig }
                            : {}),
                          ...(startup.startupCommandDelivery
                            ? { startupCommandDelivery: startup.startupCommandDelivery }
                            : {}),
                          activate: true
                        }
                      : {})
                  },
                  { timeoutMs: 10 * 60_000 }
                )
          // Why: a file watcher (worktrees.onChanged) can fire between the
          // backend creating the worktree and this callback running, causing
          // fetchWorktrees to add the worktree first. Appending unconditionally
          // then produces a duplicate entry in worktreesByRepo, which gives
          // React duplicate keys and can corrupt terminal DOM containers.
          set((s) => {
            const createdWorktree = withRepoHostId(result.worktree, repoHostId(s, repoId))
            const current = s.worktreesByRepo[repoId] ?? []
            const alreadyPresent = current.some((w) => w.id === createdWorktree.id)
            const nextWorktrees = alreadyPresent
              ? current.map((worktree) =>
                  worktree.id === createdWorktree.id
                    ? { ...worktree, ...createdWorktree }
                    : worktree
                )
              : [...current, createdWorktree]
            return {
              worktreesByRepo: {
                ...s.worktreesByRepo,
                [repoId]: nextWorktrees
              },
              ...(result.workspaceLineage
                ? {
                    workspaceLineageByChildKey: {
                      ...s.workspaceLineageByChildKey,
                      [result.workspaceLineage.childWorkspaceKey]: result.workspaceLineage
                    }
                  }
                : {}),
              ...(result.initialBaseStatus
                ? {
                    baseStatusByWorktreeId: {
                      ...s.baseStatusByWorktreeId,
                      [result.worktree.id]:
                        s.baseStatusByWorktreeId[result.worktree.id] ?? result.initialBaseStatus
                    }
                  }
                : {}),
              sortEpoch: s.sortEpoch + 1
            }
          })
          showLocalBaseRefRefreshToast(result.localBaseRefRefresh)
          showLocalBaseRefUpdateSuggestionToast(result.localBaseRefUpdateSuggestion, {
            updateSettings: get().updateSettings,
            getSettings: () => get().settings,
            openSettingsPage: get().openSettingsPage,
            openSettingsTarget: get().openSettingsTarget
          })
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const shouldRetry = retryableConflictPatterns.some((pattern) => pattern.test(message))
          if (error instanceof Error && isBranchNameOverrideConflict(error)) {
            throw error
          }
          if (!shouldRetry || attempt === 24) {
            throw error
          }
        }
      }

      throw new Error('Failed to create worktree after retrying branch conflicts.')
    } catch (err) {
      console.error('Failed to create worktree:', err)
      throw err
    }
  },

  beginPendingWorktreeCreation: (entry) => {
    set((s) => ({
      pendingWorktreeCreations: { ...s.pendingWorktreeCreations, [entry.creationId]: entry },
      activePendingCreationId: entry.creationId
    }))
  },

  updatePendingWorktreeCreation: (creationId, patch) => {
    set((s) => {
      const entry = s.pendingWorktreeCreations[creationId]
      if (!entry) {
        return {}
      }
      // Why: the main process re-emits the same phase across mutually-exclusive
      // fetch paths; skip the write when nothing changes so the strip and panel
      // don't re-render on a no-op progress event.
      const hasChange = (Object.keys(patch) as (keyof typeof patch)[]).some(
        (key) => patch[key] !== entry[key]
      )
      if (!hasChange) {
        return {}
      }
      return {
        pendingWorktreeCreations: {
          ...s.pendingWorktreeCreations,
          [creationId]: { ...entry, ...patch }
        }
      }
    })
  },

  removePendingWorktreeCreation: (creationId) => {
    set((s) => {
      if (!s.pendingWorktreeCreations[creationId]) {
        return {}
      }
      const { [creationId]: _removed, ...rest } = s.pendingWorktreeCreations
      return {
        pendingWorktreeCreations: rest,
        // Why: only clear the active surface if it pointed here, so dismissing a
        // background creation the user already navigated away from doesn't yank
        // them off whatever they're now looking at.
        ...(s.activePendingCreationId === creationId ? { activePendingCreationId: null } : {})
      }
    })
  },

  setActivePendingWorktreeCreation: (creationId) => {
    set((s) => {
      if (creationId !== null && !s.pendingWorktreeCreations[creationId]) {
        return {}
      }
      return { activePendingCreationId: creationId }
    })
  },

  removeWorktree: async (worktreeId, force) => {
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [worktreeId]: {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
      }
    }))

    try {
      const repoIdForTrust = getRepoIdFromWorktreeId(worktreeId)
      const trustDecision = await ensureHooksConfirmed(get(), repoIdForTrust, 'archive')
      const skipArchive = trustDecision === 'skip'

      const worktreeBeforeRemoval = get()
        .allWorktrees()
        .find((entry) => entry.id === worktreeId)
      const target = getActiveRuntimeTarget(settingsForWorktreeOwner(get(), worktreeId))
      const removalResult = await (target.kind === 'local'
        ? window.api.worktrees.remove({ worktreeId, force, skipArchive })
        : callRuntimeRpc<RemoveWorktreeResult>(
            target,
            'worktree.rm',
            { worktree: toRuntimeWorktreeSelector(worktreeId), force, runHooks: !skipArchive },
            { timeoutMs: 60_000 }
          ))

      const worktreeDisplayName = worktreeBeforeRemoval?.displayName?.trim()
      if (worktreeDisplayName) {
        try {
          await window.api.automations?.snapshotWorkspaceName?.({
            workspaceId: worktreeId,
            displayName: worktreeDisplayName
          })
        } catch (error) {
          // Why: preserving automation history labels is best-effort; a stale
          // preload/test harness must not block worktree removal cleanup.
          console.warn('Failed to snapshot automation workspace name:', error)
        }
      }

      // Why: backend delete paths now preflight and kill PTYs only after the
      // worktree is cleanly removable. Renderer state follows the successful
      // backend result so blocked dirty deletes keep their terminals intact.
      //
      // Why browsers first: `shutdownWorktreeTerminals` used to own the
      // `browserTabsByWorktree[worktreeId]` delete as a side effect, which would
      // race `shutdownWorktreeBrowsers`' read of the same map. After the §1.3
      // split, terminals no longer touches browser state, but we still call
      // browsers first so destroyPersistentWebview sees the workspaces in place
      // and the Chromium guests are unregistered before any other teardown work
      // can intercept them.
      await get().shutdownWorktreeBrowsers(worktreeId)
      await get().shutdownWorktreeTerminals(worktreeId)
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const tabIds = new Set(tabs.map((t) => t.id))

      // Why: deletion is async (backend + terminal/browser teardown awaited
      // above), so snapshot the sidebar's current top-row anchor in the same
      // tick we remove the row. Recording at click time goes stale across the
      // await, and this covers every delete entry point (modal, card, SSH,
      // batch) rather than only the context menu.
      requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')

      set((s) => {
        const next = { ...s.worktreesByRepo }
        for (const repoId of Object.keys(next)) {
          next[repoId] = next[repoId].filter((w) => w.id !== worktreeId)
        }
        const nextTabs = { ...s.tabsByWorktree }
        delete nextTabs[worktreeId]
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        for (const tabId of tabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
          delete nextRuntimePaneTitlesByTabId[tabId]
        }
        const nextDeleteState = { ...s.deleteStateByWorktreeId }
        delete nextDeleteState[worktreeId]
        const nextLineage = { ...s.worktreeLineageById }
        delete nextLineage[worktreeId]
        const nextWorkspaceLineage = { ...s.workspaceLineageByChildKey }
        delete nextWorkspaceLineage[worktreeWorkspaceKey(worktreeId)]
        // Clean up editor files belonging to this worktree
        const newOpenFiles = s.openFiles.filter((f) => f.worktreeId !== worktreeId)
        const nextBrowserTabsByWorktree = { ...s.browserTabsByWorktree }
        delete nextBrowserTabsByWorktree[worktreeId]
        const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        delete nextActiveFileIdByWorktree[worktreeId]
        const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
        delete nextActiveBrowserTabIdByWorktree[worktreeId]
        // Why: closeBrowserTab — which shutdownWorktreeBrowsers delegates to —
        // pushes a snapshot into recentlyClosedBrowserTabsByWorktree for the
        // Cmd+Shift+T undo path. That is correct for UI close, but wrong when
        // the owning worktree itself is being deleted: the snapshots reference
        // workspaces and pages that can never be restored. Purge the worktree
        // key symmetrically with browserTabsByWorktree. Per-workspace page
        // snapshots are already cleared upstream by closeBrowserTab.
        const nextRecentlyClosedBrowserTabsByWorktree = {
          ...s.recentlyClosedBrowserTabsByWorktree
        }
        delete nextRecentlyClosedBrowserTabsByWorktree[worktreeId]
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        delete nextActiveTabTypeByWorktree[worktreeId]
        const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
        delete nextActiveTabIdByWorktree[worktreeId]
        const nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
        // Why: the mixed terminal/editor/browser tab strip persists visual order
        // per worktree. If a deleted worktree keeps its entry, stale tab IDs stay
        // retained indefinitely even though reconcileTabOrder filters them later.
        delete nextTabBarOrderByWorktree[worktreeId]
        const nextPendingReconnectTabByWorktree = { ...s.pendingReconnectTabByWorktree }
        delete nextPendingReconnectTabByWorktree[worktreeId]
        // Why: split-tab layout/group state is owned by the worktree. Leaving it
        // behind retains full tab chrome for terminals/editors/browser tabs that
        // no longer exist and makes a deleted worktree look restorable in session
        // state even though its backing entities were already removed.
        const nextUnifiedTabsByWorktree = { ...s.unifiedTabsByWorktree }
        delete nextUnifiedTabsByWorktree[worktreeId]
        const nextGroupsByWorktree = { ...s.groupsByWorktree }
        delete nextGroupsByWorktree[worktreeId]
        const nextLayoutByWorktree = { ...s.layoutByWorktree }
        delete nextLayoutByWorktree[worktreeId]
        const nextActiveGroupIdByWorktree = { ...s.activeGroupIdByWorktree }
        delete nextActiveGroupIdByWorktree[worktreeId]
        // Why: git status / compare caches are keyed by worktree and stop being
        // refreshed once the worktree is deleted. Remove them here so deleted
        // worktrees cannot retain stale conflict badges, branch diffs, or compare
        // request keys indefinitely in a long-lived renderer session.
        const nextGitStatusByWorktree = { ...s.gitStatusByWorktree }
        delete nextGitStatusByWorktree[worktreeId]
        const nextGitStatusHeadByWorktree = { ...s.gitStatusHeadByWorktree }
        delete nextGitStatusHeadByWorktree[worktreeId]
        const nextGitIgnoredPathsByWorktree = { ...s.gitIgnoredPathsByWorktree }
        delete nextGitIgnoredPathsByWorktree[worktreeId]
        const nextGitConflictOperationByWorktree = { ...s.gitConflictOperationByWorktree }
        delete nextGitConflictOperationByWorktree[worktreeId]
        const nextTrackedConflictPathsByWorktree = { ...s.trackedConflictPathsByWorktree }
        delete nextTrackedConflictPathsByWorktree[worktreeId]
        const nextGitBranchChangesByWorktree = { ...s.gitBranchChangesByWorktree }
        delete nextGitBranchChangesByWorktree[worktreeId]
        const nextGitBranchCompareSummaryByWorktree = { ...s.gitBranchCompareSummaryByWorktree }
        delete nextGitBranchCompareSummaryByWorktree[worktreeId]
        const nextGitBranchCompareRequestKeyByWorktree = {
          ...s.gitBranchCompareRequestKeyByWorktree
        }
        delete nextGitBranchCompareRequestKeyByWorktree[worktreeId]
        const nextGitBranchCompareRequestStatusHeadByWorktree = {
          ...s.gitBranchCompareRequestStatusHeadByWorktree
        }
        delete nextGitBranchCompareRequestStatusHeadByWorktree[worktreeId]
        // Why: clean up per-file editor state for files belonging to the removed
        // worktree so stale drafts and view modes never accumulate in memory.
        const removedFileIds = new Set<string>()
        for (const file of s.openFiles) {
          if (file.worktreeId !== worktreeId) {
            continue
          }
          removedFileIds.add(file.id)
          if (file.markdownPreviewSourceFileId) {
            removedFileIds.add(file.markdownPreviewSourceFileId)
          }
        }
        const nextEditorDrafts = removedFileIds.size > 0 ? { ...s.editorDrafts } : s.editorDrafts
        const nextMarkdownViewMode =
          removedFileIds.size > 0 ? { ...s.markdownViewMode } : s.markdownViewMode
        const nextEditorViewMode =
          removedFileIds.size > 0 ? { ...s.editorViewMode } : s.editorViewMode
        const nextMarkdownFrontmatterVisible =
          removedFileIds.size > 0
            ? { ...s.markdownFrontmatterVisible }
            : s.markdownFrontmatterVisible
        // Why: editorCursorLine is keyed by fileId and must be cleared with the
        // other per-file editor state so it does not leak per removed file.
        const nextEditorCursorLine =
          removedFileIds.size > 0 ? { ...s.editorCursorLine } : s.editorCursorLine
        if (removedFileIds.size > 0) {
          for (const fileId of removedFileIds) {
            delete nextEditorDrafts[fileId]
            delete nextMarkdownViewMode[fileId]
            delete nextEditorViewMode[fileId]
            delete nextMarkdownFrontmatterVisible[fileId]
            delete nextEditorCursorLine[fileId]
          }
        }
        const nextExpandedDirs = { ...s.expandedDirs }
        delete nextExpandedDirs[worktreeId]
        const nextShowDotfilesByWorktree = { ...s.showDotfilesByWorktree }
        delete nextShowDotfilesByWorktree[worktreeId]
        // Why: keyed by worktreeId; clear the huge-status marker so it does not
        // linger after the worktree is gone.
        const nextGitStatusHugeByWorktree = { ...s.gitStatusHugeByWorktree }
        delete nextGitStatusHugeByWorktree[worktreeId]
        const nextRightSidebarExplorerViewByWorktree = {
          ...s.rightSidebarExplorerViewByWorktree
        }
        delete nextRightSidebarExplorerViewByWorktree[worktreeId]
        // If the active file belonged to the removed worktree, clear it
        const activeFileCleared = s.activeFileId
          ? s.openFiles.some((f) => f.id === s.activeFileId && f.worktreeId === worktreeId)
          : false
        const removedActiveWorktree = s.activeWorktreeId === worktreeId
        const nextEverActivatedWorktreeIds = s.everActivatedWorktreeIds.has(worktreeId)
          ? new Set([...s.everActivatedWorktreeIds].filter((id) => id !== worktreeId))
          : s.everActivatedWorktreeIds
        const nextLastVisitedAtByWorktreeId =
          worktreeId in s.lastVisitedAtByWorktreeId
            ? (() => {
                const next = { ...s.lastVisitedAtByWorktreeId }
                delete next[worktreeId]
                return next
              })()
            : s.lastVisitedAtByWorktreeId
        return {
          worktreesByRepo: next,
          worktreeLineageById: nextLineage,
          workspaceLineageByChildKey: nextWorkspaceLineage,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
          terminalLayoutsByTabId: nextLayouts,
          deleteStateByWorktreeId: nextDeleteState,
          baseStatusByWorktreeId: (() => {
            const nextStatus = { ...s.baseStatusByWorktreeId }
            delete nextStatus[worktreeId]
            return nextStatus
          })(),
          remoteBranchConflictByWorktreeId: (() => {
            const nextConflict = { ...s.remoteBranchConflictByWorktreeId }
            delete nextConflict[worktreeId]
            return nextConflict
          })(),
          fileSearchStateByWorktree: (() => {
            const nextSearch = { ...s.fileSearchStateByWorktree }
            // Why: file search UI state is worktree-scoped. Removing the worktree
            // must also remove its cached query/results so another worktree never
            // inherits stale matches from a path that no longer exists.
            delete nextSearch[worktreeId]
            return nextSearch
          })(),
          // Why: these worktree-keyed maps are re-keyed on rename but were missed
          // by both removal paths, leaking one entry per removed worktree.
          remoteStatusesByWorktree: (() => {
            const next = { ...s.remoteStatusesByWorktree }
            delete next[worktreeId]
            return next
          })(),
          recentlyClosedEditorTabsByWorktree: (() => {
            const next = { ...s.recentlyClosedEditorTabsByWorktree }
            delete next[worktreeId]
            return next
          })(),
          defaultTerminalTabsAppliedByWorktreeId: (() => {
            const next = { ...s.defaultTerminalTabsAppliedByWorktreeId }
            delete next[worktreeId]
            return next
          })(),
          activeWorktreeId: removedActiveWorktree ? null : s.activeWorktreeId,
          activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
          openFiles: newOpenFiles,
          browserTabsByWorktree: nextBrowserTabsByWorktree,
          recentlyClosedBrowserTabsByWorktree: nextRecentlyClosedBrowserTabsByWorktree,
          activeFileIdByWorktree: nextActiveFileIdByWorktree,
          activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          rightSidebarExplorerViewByWorktree: nextRightSidebarExplorerViewByWorktree,
          activeTabIdByWorktree: nextActiveTabIdByWorktree,
          tabBarOrderByWorktree: nextTabBarOrderByWorktree,
          pendingReconnectTabByWorktree: nextPendingReconnectTabByWorktree,
          unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
          groupsByWorktree: nextGroupsByWorktree,
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
          editorDrafts: nextEditorDrafts,
          markdownViewMode: nextMarkdownViewMode,
          editorViewMode: nextEditorViewMode,
          markdownFrontmatterVisible: nextMarkdownFrontmatterVisible,
          editorCursorLine: nextEditorCursorLine,
          showDotfilesByWorktree: nextShowDotfilesByWorktree,
          expandedDirs: nextExpandedDirs,
          gitStatusHugeByWorktree: nextGitStatusHugeByWorktree,
          gitStatusByWorktree: nextGitStatusByWorktree,
          gitStatusHeadByWorktree: nextGitStatusHeadByWorktree,
          gitIgnoredPathsByWorktree: nextGitIgnoredPathsByWorktree,
          gitConflictOperationByWorktree: nextGitConflictOperationByWorktree,
          trackedConflictPathsByWorktree: nextTrackedConflictPathsByWorktree,
          gitBranchChangesByWorktree: nextGitBranchChangesByWorktree,
          gitBranchCompareSummaryByWorktree: nextGitBranchCompareSummaryByWorktree,
          gitBranchCompareRequestKeyByWorktree: nextGitBranchCompareRequestKeyByWorktree,
          gitBranchCompareRequestStatusHeadByWorktree:
            nextGitBranchCompareRequestStatusHeadByWorktree,
          activeFileId: activeFileCleared ? null : s.activeFileId,
          activeBrowserTabId: removedActiveWorktree ? null : s.activeBrowserTabId,
          activeTabType: removedActiveWorktree || activeFileCleared ? 'terminal' : s.activeTabType,
          everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
          lastVisitedAtByWorktreeId: nextLastVisitedAtByWorktreeId,
          sortEpoch: s.sortEpoch + 1
        }
      })
      get().removeWorkspaceSpaceWorktrees?.([worktreeId])
      // Why: PR/commit-message generation records are keyed by worktree and were
      // never evicted on removal — they leaked one record (title/body text) per
      // worktree for the session. Prune to the surviving worktree set, reusing
      // the generation slices' tested prune actions.
      const liveWorktreeKeys = new Set(
        get()
          .allWorktrees()
          .map((w) => w.id)
      )
      // Optional-chained like removeWorkspaceSpaceWorktrees above: minimal store
      // assemblies (some unit tests) omit the generation slices.
      get().prunePullRequestGenerationRecords?.(liveWorktreeKeys)
      get().pruneCommitMessageGenerationRecords?.(liveWorktreeKeys)
      // Why: Source Control may be unmounted during deletion, so its local
      // prune effect cannot be the only stale-draft cleanup path.
      clearSessionCommitDraftForWorktree(worktreeId)
      const preservedBranch = removalResult?.preservedBranch
      if (preservedBranch) {
        showPreservedBranchToast(removalResult, worktreeBeforeRemoval, (branch, expectedHead) => {
          void get().forceDeletePreservedBranch(worktreeId, branch, expectedHead)
        })
      }
      pruneHostedReviewLinkMutationGenerations([worktreeId])
      return preservedBranch ? { ok: true as const, preservedBranch } : { ok: true as const }
    } catch (err) {
      // Why: git refusing a non-force delete for dirty/untracked files is a
      // handled user decision point surfaced by the delete toast, not an app error.
      console.warn('Failed to remove worktree:', err)
      const error = err instanceof Error ? err.message : String(err)
      set((s) => ({
        deleteStateByWorktreeId: {
          ...s.deleteStateByWorktreeId,
          [worktreeId]: {
            isDeleting: false,
            error,
            canForceDelete: canRetryWorktreeRemovalWithForce(error, force)
          }
        }
      }))
      return { ok: false as const, error }
    }
  },

  markWorktreesDeleting: (worktreeIds) => {
    if (worktreeIds.length === 0) {
      return
    }
    set((s) => {
      const nextDeleteState = { ...s.deleteStateByWorktreeId }
      let changed = false
      for (const worktreeId of new Set(worktreeIds)) {
        const current = nextDeleteState[worktreeId]
        if (current?.isDeleting && current.error === null && !current.canForceDelete) {
          continue
        }
        nextDeleteState[worktreeId] = {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
    })
  },

  forceDeletePreservedBranch: async (worktreeId, branchName, expectedHead) => {
    try {
      const target = getActiveRuntimeTarget(settingsForWorktreeOwner(get(), worktreeId))
      const result = await (target.kind === 'local'
        ? window.api.worktrees.forceDeletePreservedBranch({
            worktreeId,
            branchName,
            expectedHead
          })
        : callRuntimeRpc<ForceDeleteWorktreeBranchResult>(
            target,
            'worktree.forceDeleteBranch',
            { worktree: toRuntimeWorktreeSelector(worktreeId), branchName, expectedHead },
            { timeoutMs: 15_000 }
          ))
      toast.success(translate('auto.store.slices.worktrees.19db0085fb', 'Local branch deleted'), {
        description: translate('auto.store.slices.worktrees.5a58e03a26', 'Deleted "{{value0}}".', {
          value0: branchName
        })
      })
      return { ok: true as const, ...result }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      toast.error(translate('auto.store.slices.worktrees.0216895fb5', 'Failed to delete branch'), {
        description: error
      })
      return { ok: false as const, error }
    }
  },

  clearWorktreeDeleteState: (worktreeId) => {
    set((s) => {
      if (!s.deleteStateByWorktreeId[worktreeId]) {
        return {}
      }
      const next = { ...s.deleteStateByWorktreeId }
      delete next[worktreeId]
      return { deleteStateByWorktreeId: next }
    })
  },

  updateWorktreeMeta: async (worktreeId, updates, options) => {
    const shouldApplyUpdate = options?.shouldApply
    const existingWorktree = get().getKnownWorktreeById(worktreeId)
    if (shouldApplyUpdate && !shouldApplyUpdate(existingWorktree)) {
      return
    }
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderUpdates = getFolderWorkspaceMetaUpdates(updates)
      if (Object.keys(folderUpdates).length > 0) {
        await get().updateFolderWorkspace(workspaceScope.folderWorkspaceId, folderUpdates)
      }
      return
    }
    const normalizedUpdates = existingWorktree
      ? clearOlderHostedReviewLinksForReplacement(updates, existingWorktree)
      : updates
    // Why: manual PR linking only supplies the PR number. Resolve the PR head
    // branch here so Push targets the review branch, but don't repeat that
    // network lookup for no-op linkedPR metadata saves.
    const linkedPrForPushTarget = isPositiveHostedReviewNumber(normalizedUpdates.linkedPR)
      ? normalizedUpdates.linkedPR
      : null
    const resolvedPushTarget =
      linkedPrForPushTarget !== null &&
      normalizedUpdates.pushTarget === undefined &&
      existingWorktree &&
      existingWorktree.linkedPR !== linkedPrForPushTarget &&
      !existingWorktree.pushTarget
        ? await resolveGitHubReviewPushTarget(
            settingsForWorktreeOwner(get(), worktreeId),
            existingWorktree.repoId,
            linkedPrForPushTarget
          )
        : undefined
    const existingHostedReviewPushTargetLookup = existingWorktree
      ? getHostedReviewPushTargetLookup(existingWorktree)
      : null
    const nextHostedReviewPushTargetLookup = existingWorktree
      ? getHostedReviewPushTargetLookup({ ...existingWorktree, ...normalizedUpdates })
      : null
    // Why: a pushTarget derived from one linked review must not keep steering
    // pushes after that review is unlinked or replaced by another provider/id.
    const shouldClearStaleHostedReviewPushTarget =
      Boolean(existingWorktree?.pushTarget) &&
      normalizedUpdates.pushTarget === undefined &&
      resolvedPushTarget === undefined &&
      existingHostedReviewPushTargetLookup !== null &&
      existingHostedReviewPushTargetLookup.key !== nextHostedReviewPushTargetLookup?.key
    const worktreeForUpdate = get().getKnownWorktreeById(worktreeId)
    if (shouldApplyUpdate && !shouldApplyUpdate(worktreeForUpdate)) {
      return
    }
    const shouldRefreshHostedReview =
      (normalizedUpdates.linkedPR === null && worktreeForUpdate?.linkedPR !== null) ||
      (normalizedUpdates.linkedGitLabMR === null &&
        (worktreeForUpdate?.linkedGitLabMR ?? null) !== null) ||
      (normalizedUpdates.linkedBitbucketPR === null &&
        (worktreeForUpdate?.linkedBitbucketPR ?? null) !== null) ||
      (normalizedUpdates.linkedAzureDevOpsPR === null &&
        (worktreeForUpdate?.linkedAzureDevOpsPR ?? null) !== null) ||
      (normalizedUpdates.linkedGiteaPR === null &&
        (worktreeForUpdate?.linkedGiteaPR ?? null) !== null)
    const reviewRepo = shouldRefreshHostedReview
      ? get().repos.find((repo) => repo.id === worktreeForUpdate?.repoId)
      : undefined
    const reviewBranch = worktreeForUpdate?.branch.replace(/^refs\/heads\//, '')

    // Why: editing a comment is meaningful interaction with the worktree.
    // Without refreshing lastActivityAt, the time-decay score has decayed
    // since the previous sort, so a re-sort causes the worktree to drop in
    // ranking even though the user just touched it. Bumping the timestamp
    // keeps the recency signal fresh so the worktree holds its position.
    const targetEnriched = resolvedPushTarget
      ? { ...normalizedUpdates, pushTarget: resolvedPushTarget }
      : shouldClearStaleHostedReviewPushTarget
        ? { ...normalizedUpdates, pushTarget: undefined }
        : normalizedUpdates
    const renameCleared =
      'displayName' in targetEnriched
        ? {
            ...targetEnriched,
            pendingFirstAgentMessageRename: false,
            firstAgentMessageRenameError: null
          }
        : targetEnriched
    const enriched =
      'comment' in renameCleared ? { ...renameCleared, lastActivityAt: Date.now() } : renameCleared

    let didApply = false
    set((s) => {
      if (shouldApplyUpdate && !shouldApplyUpdate(findKnownWorktreeById(s, worktreeId))) {
        return {}
      }
      didApply = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, enriched)
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        enriched
      )
      const cacheKey =
        reviewRepo && reviewBranch
          ? getHostedReviewCacheKey(
              reviewRepo.path,
              reviewBranch,
              s.settings,
              reviewRepo.id,
              reviewRepo.connectionId,
              reviewRepo.executionHostId,
              true
            )
          : null
      const prCacheKey =
        reviewRepo && reviewBranch
          ? getGitHubPRCacheKey(
              reviewRepo.path,
              reviewRepo.id,
              reviewBranch,
              s.settings,
              reviewRepo.connectionId,
              reviewRepo.executionHostId,
              true
            )
          : null
      const prCacheKeys =
        reviewRepo && reviewBranch
          ? [
              prCacheKey,
              getLegacyGitHubPRCacheKey(reviewRepo.path, reviewRepo.id, reviewBranch),
              getLegacyGitHubPRCacheKey(reviewRepo.path, undefined, reviewBranch)
            ].filter((key): key is string => Boolean(key))
          : []
      const hostedReviewCache = s.hostedReviewCache ?? {}
      const prCache = s.prCache ?? {}
      if (
        nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo &&
        !cacheKey &&
        !prCacheKey
      ) {
        return {}
      }

      const nextHostedReviewCache =
        cacheKey && hostedReviewCache[cacheKey]
          ? (() => {
              const next = { ...hostedReviewCache }
              delete next[cacheKey]
              return next
            })()
          : hostedReviewCache
      const nextPRCache = prCacheKeys.some((key) => prCache[key])
        ? (() => {
            const next = { ...prCache }
            for (const key of prCacheKeys) {
              delete next[key]
            }
            return next
          })()
        : prCache

      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {}),
        ...(nextHostedReviewCache !== hostedReviewCache
          ? { hostedReviewCache: nextHostedReviewCache }
          : {}),
        ...(nextPRCache !== prCache ? { prCache: nextPRCache } : {})
      }
    })
    if (shouldApplyUpdate && !didApply) {
      return
    }
    if (hasHostedReviewLinkUpdates(enriched)) {
      bumpHostedReviewLinkMutationGeneration(worktreeId)
    }

    try {
      await persistWorktreeMeta(settingsForWorktreeOwner(get(), worktreeId), worktreeId, enriched)
      if (reviewRepo && reviewBranch && typeof get().fetchHostedReviewForBranch === 'function') {
        // Why: the old cache entry may have been populated by the previous
        // provider link. Refetch against the post-update links so stale lookups
        // cannot keep showing the removed review.
        void get().fetchHostedReviewForBranch(reviewRepo.path, reviewBranch, {
          repoId: reviewRepo.id,
          linkedGitHubPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedPR'
          ),
          linkedGitLabMR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedGitLabMR'
          ),
          linkedBitbucketPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedBitbucketPR'
          ),
          linkedAzureDevOpsPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedAzureDevOpsPR'
          ),
          linkedGiteaPR: getHostedReviewLinkForMetaRefresh(
            targetEnriched,
            worktreeForUpdate,
            'linkedGiteaPR'
          ),
          force: true
        })
      }
    } catch (err) {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return
      }
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    }
  },

  ensureHostedReviewPushTarget: async (worktreeId) => {
    const worktree = get().getKnownWorktreeById(worktreeId)
    if (!worktree || worktree.pushTarget) {
      return
    }
    const lookup = getHostedReviewPushTargetLookup(worktree)
    if (!lookup || hostedReviewPushTargetLookupsInFlight.has(lookup.key)) {
      return
    }
    hostedReviewPushTargetLookupsInFlight.add(lookup.key)
    try {
      const resolvedPushTarget = await lookup.resolve(settingsForWorktreeOwner(get(), worktreeId))
      if (!resolvedPushTarget) {
        return
      }
      const current = get().getKnownWorktreeById(worktreeId)
      if (!current || current.pushTarget) {
        return
      }
      const currentLookup = getHostedReviewPushTargetLookup(current)
      if (currentLookup?.key !== lookup.key) {
        return
      }
      // Why: old linked-review worktrees can lose metadata while their branch
      // tracks a helper ref; restoring the review head target keeps push/status aligned.
      await get().updateWorktreeMeta(worktreeId, { pushTarget: resolvedPushTarget })
    } finally {
      hostedReviewPushTargetLookupsInFlight.delete(lookup.key)
    }
  },

  updateWorktreesMeta: async (updatesByWorktreeId) => {
    if (updatesByWorktreeId.size === 0) {
      return
    }

    set((s) => {
      let nextWorktrees = s.worktreesByRepo
      let nextDetectedWorktrees = s.detectedWorktreesByRepo
      for (const [worktreeId, updates] of updatesByWorktreeId) {
        nextWorktrees = applyWorktreeUpdates(nextWorktrees, worktreeId, updates)
        nextDetectedWorktrees = applyDetectedWorktreeUpdates(
          nextDetectedWorktrees,
          worktreeId,
          updates
        )
      }
      return nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo
        ? {}
        : {
            ...(nextWorktrees !== s.worktreesByRepo
              ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
              : {}),
            ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
              ? { detectedWorktreesByRepo: nextDetectedWorktrees }
              : {})
          }
    })

    await Promise.all(
      Array.from(updatesByWorktreeId, async ([worktreeId, updates]) => {
        try {
          await persistWorktreeMeta(
            settingsForWorktreeOwner(get(), worktreeId),
            worktreeId,
            updates
          )
        } catch (err) {
          if (isRuntimeSelectorNotFoundError(err)) {
            void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
            return
          }
          console.error('Failed to update worktree meta:', err)
          void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        }
      })
    )
  },

  setWorktreesPinnedAndReveal: (worktreeIds, isPinned) => {
    // Skip worktrees already in the target state so a no-op toggle doesn't
    // scroll the viewport away from where the user is.
    const updates = new Map<string, Partial<WorktreeMeta>>()
    let revealWorktreeId: string | null = null
    for (const worktreeId of worktreeIds) {
      const current = get().getKnownWorktreeById(worktreeId)
      if (!current || current.isPinned === isPinned) {
        continue
      }
      const workspaceScope = parseWorkspaceKey(worktreeId)
      if (workspaceScope?.type === 'folder') {
        void get().updateWorktreeMeta(worktreeId, { isPinned })
      } else {
        updates.set(worktreeId, { isPinned })
      }
      if (revealWorktreeId === null) {
        revealWorktreeId = worktreeId
      }
    }
    if (revealWorktreeId === null) {
      return
    }
    // updateWorktreesMeta applies its store update synchronously (only the
    // persistence is async), so the reveal below resolves against a render
    // where the shortcut row already exists.
    void get().updateWorktreesMeta(updates)
    get().revealWorktreeInSidebar(revealWorktreeId, { behavior: 'smooth', highlight: true })
  },

  markWorktreeUnread: (worktreeId) => {
    // Why: terminal attention should remain visible until the user engages
    // with the worktree. Interaction with a pane inside the worktree dismisses
    // the dot via clearWorktreeUnread. Worktree activation via setActiveWorktree
    // also clears isUnread as a side-effect; that path predates this PR and is
    // unaffected here.
    let shouldPersist = false
    const now = Date.now()
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree || worktree.isUnread) {
        return {}
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        isUnread: true,
        lastActivityAt: now
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: true,
          lastActivityAt: now
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    void persistWorktreeMeta(settingsForWorktreeOwner(get(), worktreeId), worktreeId, {
      isUnread: true,
      lastActivityAt: now
    }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return
      }
      console.error('Failed to persist unread worktree state:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  },

  observeTerminalGitHubPullRequestLink: (worktreeId, link) => {
    const state = get()
    const worktree = findKnownWorktreeById(state, worktreeId)
    if (!worktree || worktree.isBare || worktree.isArchived) {
      return
    }
    const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
    if (!repo || (repo.kind && repo.kind !== 'git')) {
      return
    }
    if (typeof worktree.linkedPR === 'number' && worktree.linkedPR !== link.number) {
      return
    }

    const branch = branchName(worktree.branch)
    const alreadyLinked = worktree.linkedPR === link.number

    const fetchPRForBranch = get().fetchPRForBranch
    if (typeof fetchPRForBranch === 'function') {
      void fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        worktreeId,
        linkedPRNumber: alreadyLinked ? link.number : null,
        fallbackPRNumber: null,
        fallbackPRSource: alreadyLinked ? null : 'explicit'
      }).then((pr) => {
        if (!alreadyLinked && pr?.number === link.number) {
          // Why: terminal output can include arbitrary PR URLs from docs,
          // agents, or logs. Persist only after branch lookup confirms it and
          // the user has not picked a different PR while lookup was in flight.
          void get().updateWorktreeMeta(
            worktreeId,
            { linkedPR: link.number },
            {
              shouldApply: (currentWorktree) =>
                Boolean(
                  currentWorktree &&
                  !currentWorktree.isBare &&
                  !currentWorktree.isArchived &&
                  (currentWorktree.linkedPR == null || currentWorktree.linkedPR === link.number)
                )
            }
          )
        }
      })
      return
    }

    const fetchHostedReviewForBranch = get().fetchHostedReviewForBranch
    if (typeof fetchHostedReviewForBranch === 'function') {
      // Why: full app stores always have fetchPRForBranch, which syncs the
      // GitHub hosted-review cache. Keep this only as a slice-test fallback.
      void refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: alreadyLinked ? link.number : null,
        fallbackGitHubPR: null,
        linkedGitLabMR: worktree.linkedGitLabMR ?? null
      })
    }
  },

  clearWorktreeUnread: (worktreeId) => {
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree || !worktree.isUnread) {
        // Why: return `s` (not `{}`) to preserve the exact object reference
        // on no-op. This matches the sibling `clearTerminalTabUnread` in
        // terminals.ts and avoids downstream selector churn on the hot path
        // (called on every keystroke and pointerdown).
        return s
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        isUnread: false
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: false
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    void persistWorktreeMeta(settingsForWorktreeOwner(get(), worktreeId), worktreeId, {
      isUnread: false
    }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return
      }
      console.error('Failed to persist cleared unread worktree state:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  },

  bumpWorktreeActivity: (worktreeId) => {
    const now = Date.now()
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree) {
        return {}
      }
      shouldPersist = true
      // Skip sortEpoch bump for the active worktree. Terminal events
      // (PTY spawn, PTY exit) in the active worktree are side-effects of
      // the user clicking the card or interacting with the terminal —
      // re-sorting the sidebar in response would cause the exact reorder-
      // on-click bug PR #209 intended to fix (e.g. dead-PTY reconnection
      // after generation bump triggers updateTabPtyId → here).
      // The lastActivityAt timestamp is still persisted so that the NEXT
      // meaningful sortEpoch bump (from a background worktree event) will
      // include this worktree's updated smart-sort score.
      const isActive = s.activeWorktreeId === worktreeId
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        lastActivityAt: now
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          lastActivityAt: now
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? {
              worktreesByRepo: nextWorktrees,
              ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
            }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    void persistWorktreeMeta(settingsForWorktreeOwner(get(), worktreeId), worktreeId, {
      lastActivityAt: now
    }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        return
      }
      console.error('Failed to persist worktree activity timestamp:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  },

  markWorktreeVisited: (worktreeId, visitedAt) => {
    // Why: Cmd+J's empty-query ordering needs a focus-recency signal that is
    // distinct from worktree.lastActivityAt (which is driven by background
    // PTY/activity events). Monotonic: CLI- and IPC-driven activations can
    // race, so older timestamps must not regress the stored value. See
    // docs/cmd-j-empty-query-ordering.md.
    set((s) => {
      const now = visitedAt ?? Date.now()
      const prev = s.lastVisitedAtByWorktreeId[worktreeId] ?? 0
      if (!(now > prev)) {
        return {}
      }
      return {
        lastVisitedAtByWorktreeId: {
          ...s.lastVisitedAtByWorktreeId,
          [worktreeId]: now
        }
      }
    })
  },

  pruneLastVisitedTimestamps: () => {
    set((s) => {
      // Why: scope pruning per-repo. SSH-backed repos cannot enumerate
      // worktrees until their connection is established, so at hydration
      // time worktreesByRepo[sshRepoId] is empty/undefined. If we pruned
      // globally based on the union of all repos' worktrees, we would wipe
      // every persisted focus-recency entry for SSH worktrees — precisely
      // the set this feature exists to preserve. Instead, only drop entries
      // whose repo has a populated worktree list: a missing repoId means
      // "not yet hydrated" (defer), a repoId with an empty list after a
      // successful listing means the worktree really is gone (drop).
      // The ssh:state-changed 'connected' handler re-fetches worktrees and
      // a follow-up prune runs from the same site if needed.
      const validIdsByRepo = new Map<string, Set<string>>()
      for (const [repoId, list] of Object.entries(s.worktreesByRepo)) {
        if (s.detectedWorktreesByRepo[repoId]) {
          continue
        }
        validIdsByRepo.set(repoId, new Set(list.map((worktree) => worktree.id)))
      }
      for (const [repoId, result] of Object.entries(s.detectedWorktreesByRepo)) {
        if (result.authoritative) {
          validIdsByRepo.set(repoId, new Set(result.worktrees.map((worktree) => worktree.id)))
        }
      }
      let changed = false
      const next: Record<string, number> = {}
      for (const [id, ts] of Object.entries(s.lastVisitedAtByWorktreeId)) {
        const repoId = getRepoIdFromWorktreeId(id)
        const repoIds = validIdsByRepo.get(repoId)
        if (!repoIds) {
          // Repo not yet hydrated (e.g. SSH not connected). Keep the entry.
          next[id] = ts
          continue
        }
        if (repoIds.has(id)) {
          next[id] = ts
        } else {
          changed = true
        }
      }
      return changed ? { lastVisitedAtByWorktreeId: next } : {}
    })
  },

  seedActiveWorktreeLastVisitedIfMissing: () => {
    set((s) => {
      const id = s.activeWorktreeId
      if (!id) {
        return {}
      }
      if (s.lastVisitedAtByWorktreeId[id] != null) {
        return {}
      }
      return {
        lastVisitedAtByWorktreeId: {
          ...s.lastVisitedAtByWorktreeId,
          [id]: Date.now()
        }
      }
    })
  },

  setRenamingWorktreeId: (request) => {
    set({
      renamingWorktreeId: typeof request === 'string' ? { worktreeId: request } : request
    })
  },

  setActiveWorktree: (worktreeId) => {
    if (worktreeId && shouldDeferActivationTerminalPrep()) {
      markInputQuietSchedulerInput()
    }

    if (get().activeWorktreeId !== worktreeId) {
      moveFocusToRendererBeforeFocusedWebviewHidden()
    }
    const reconciledActiveTabId = worktreeId
      ? get().reconcileWorktreeTabModel(worktreeId).activeRenderableTabId
      : null
    let shouldClearUnread = false
    let shouldPrepareTerminalTabs = false
    let shouldTagTerminalTabs = false
    set((s) => {
      if (!worktreeId) {
        return {
          activeWorktreeId: null,
          activeWorkspaceKey: null,
          // Why: activating any real worktree (or clearing it) must dismiss the
          // background-creation panel so the user isn't stranded on it.
          activePendingCreationId: null
        }
      }

      const worktree = findKnownWorktreeById(s, worktreeId)
      shouldClearUnread = Boolean(worktree?.isUnread)

      // Restore per-worktree editor state
      // Why: Search now lives under Explorer, so the files/search sub-route
      // must switch with the worktree instead of leaking the previous one.
      const restoredRightSidebarExplorerView =
        s.rightSidebarExplorerViewByWorktree?.[worktreeId] ?? 'files'
      const restoredFileId = s.activeFileIdByWorktree[worktreeId] ?? null
      const restoredBrowserTabId = s.activeBrowserTabIdByWorktree[worktreeId] ?? null
      const restoredTabType = s.activeTabTypeByWorktree[worktreeId] ?? 'terminal'
      const activeGroupId =
        s.activeGroupIdByWorktree[worktreeId] ?? s.groupsByWorktree[worktreeId]?.[0]?.id ?? null
      const activeGroup = activeGroupId
        ? ((s.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId) ??
          null)
        : null
      const activeUnifiedTabId = reconciledActiveTabId ?? activeGroup?.activeTabId ?? null
      const activeUnifiedTab =
        activeUnifiedTabId != null
          ? ((s.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (tab) =>
                tab.id === activeUnifiedTabId && (!activeGroup || tab.groupId === activeGroup.id)
            ) ?? null)
          : null
      // Verify the restored file still exists in openFiles
      const fileStillOpen = restoredFileId
        ? s.openFiles.some((f) => f.id === restoredFileId && f.worktreeId === worktreeId)
        : false
      const browserTabs = s.browserTabsByWorktree[worktreeId] ?? []
      const browserTabStillOpen = restoredBrowserTabId
        ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
        : false
      const hasGroupOwnedSurface =
        (s.groupsByWorktree[worktreeId]?.length ?? 0) > 0 || Boolean(s.layoutByWorktree[worktreeId])

      // Why: worktree activation must restore from the reconciled tab-group
      // model first. Split groups are now the ownership model for visible
      // content; if we prefer the legacy activeTabType/browser/file fallbacks
      // when the two models disagree, the renderer can reopen a surface that
      // has no backing unified tab and show a blank worktree.
      let activeFileId: string | null
      let activeBrowserTabId: string | null
      let activeTabType: WorkspaceVisibleTabType
      if (activeUnifiedTab) {
        activeFileId =
          activeUnifiedTab.contentType === 'editor' ||
          activeUnifiedTab.contentType === 'diff' ||
          activeUnifiedTab.contentType === 'conflict-review' ||
          activeUnifiedTab.contentType === 'check-details'
            ? activeUnifiedTab.entityId
            : fileStillOpen
              ? restoredFileId
              : null
        activeBrowserTabId =
          activeUnifiedTab.contentType === 'browser'
            ? activeUnifiedTab.entityId
            : browserTabStillOpen
              ? restoredBrowserTabId
              : (browserTabs[0]?.id ?? null)
        activeTabType = toVisibleTabType(activeUnifiedTab.contentType)
      } else if (hasGroupOwnedSurface) {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'terminal'
      } else if (restoredTabType === 'terminal') {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'terminal'
      } else if (restoredTabType === 'browser' && browserTabStillOpen) {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = restoredBrowserTabId
        activeTabType = 'browser'
      } else if (restoredTabType === 'editor' && fileStillOpen) {
        activeFileId = restoredFileId
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'editor'
      } else if (browserTabStillOpen) {
        activeFileId = null
        activeBrowserTabId = restoredBrowserTabId
        activeTabType = 'browser'
      } else if (fileStillOpen) {
        activeFileId = restoredFileId
        activeBrowserTabId = browserTabs[0]?.id ?? null
        activeTabType = 'editor'
      } else {
        const fallbackFile = s.openFiles.find((f) => f.worktreeId === worktreeId)
        const fallbackBrowserTab = browserTabs[0] ?? null
        activeFileId = fallbackFile?.id ?? null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (fallbackBrowserTab?.id ?? null)
        activeTabType = fallbackFile ? 'editor' : fallbackBrowserTab ? 'browser' : 'terminal'
      }

      // Why: restore the last-active terminal tab for this worktree so the
      // user returns to the same tab they left, not always the first one.
      const restoredTabId = s.activeTabIdByWorktree[worktreeId] ?? null
      const worktreeTabs = s.tabsByWorktree[worktreeId] ?? []
      const tabStillExists = restoredTabId
        ? worktreeTabs.some((t) => t.id === restoredTabId)
        : false
      const activeTabId =
        activeUnifiedTab?.contentType === 'terminal'
          ? activeUnifiedTab.entityId
          : tabStillExists
            ? restoredTabId
            : (worktreeTabs[0]?.id ?? null)

      // Why: focusing a worktree is not meaningful background activity for the
      // smart sort. Writing lastActivityAt here makes the next unrelated
      // sortEpoch bump reshuffle cards based on what the user merely looked at,
      // which is the "jump after focus" bug reported in Slack. Keep selection
      // side-effects limited to unread clearing; true activity signals such as
      // PTY lifecycle and explicit edits still flow through bumpWorktreeActivity.
      const metaUpdates: Partial<WorktreeMeta> = shouldClearUnread ? { isUnread: false } : {}

      // Why: dead-PTY terminal prep must complete before the workspace shell
      // renders that tab. The shell render is deferred below, so terminal prep
      // can wait for input quiet instead of blocking the activation click.
      //
      // Why pendingActivationSpawn + first-activation check: the first time a
      // worktree is activated in this session, its TerminalPane mounts and
      // each tab's PTY either reattaches (restored session) or fresh-spawns
      // (never visited). Both paths call updateTabPtyId; neither is real
      // activity — they are side-effects of the click. Tag every tab on the
      // FIRST activation so the resulting updateTabPtyId suppresses both the
      // activity bump and the sortEpoch bump.
      //
      // We can't use tab.ptyId==null as the guard (what the old `allDead`
      // check did): reconnectPersistedTerminals re-populates tab.ptyId with
      // restored daemon session IDs *before* the pane mounts, so tabs look
      // live to allDead even though the next updateTabPtyId is a reattach.
      // Tracking first-activation per worktree is the reliable signal.
      //
      // Generation is still only bumped when tabs have no live PTY — a live
      // tab remount would kill the user's running shell.
      const tabs = s.tabsByWorktree[worktreeId ?? ''] ?? []
      const allDead =
        worktreeId != null &&
        tabs.length > 0 &&
        tabs.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
      const isFirstActivation = worktreeId != null && !s.everActivatedWorktreeIds.has(worktreeId)
      const shouldTagTabs = worktreeId != null && tabs.length > 0 && isFirstActivation
      // Why: when every PTY for the worktree's tabs is dead, the existing
      // (hidden) TerminalPane wraps a dead transport. Once activeWorktreeId
      // commits, that pane becomes visible and accepts keystrokes that the
      // dead transport silently drops. Bump generation in the SAME set() so
      // React/Zustand commit activation and the remount key in one render —
      // no visible-but-dead-transport window. First-activation tagging
      // (shouldTagTabs without allDead) does not remount panes and stays on
      // the deferred path below.
      shouldPrepareTerminalTabs = Boolean(
        worktreeId && tabs.length > 0 && shouldTagTabs && !allDead
      )
      shouldTagTerminalTabs = shouldTagTabs
      const nextEverActivated = isFirstActivation
        ? new Set([...s.everActivatedWorktreeIds, worktreeId!])
        : s.everActivatedWorktreeIds
      const nextWorktrees = shouldClearUnread
        ? applyWorktreeUpdates(s.worktreesByRepo, worktreeId, metaUpdates)
        : s.worktreesByRepo
      const nextDetectedWorktrees = shouldClearUnread
        ? applyDetectedWorktreeUpdates(s.detectedWorktreesByRepo, worktreeId, metaUpdates)
        : s.detectedWorktreesByRepo
      const tabsByWorktreeUpdate =
        allDead && worktreeId != null
          ? {
              tabsByWorktree: {
                ...s.tabsByWorktree,
                [worktreeId]: tabs.map((tab) => ({
                  ...tab,
                  generation: (tab.generation ?? 0) + 1,
                  pendingActivationSpawn: getActivationSpawnSuppression(
                    s.terminalLayoutsByTabId[tab.id]
                  )
                }))
              }
            }
          : {}

      const nextActiveTabTypeByWorktree =
        s.activeTabTypeByWorktree[worktreeId] === activeTabType
          ? s.activeTabTypeByWorktree
          : { ...s.activeTabTypeByWorktree, [worktreeId]: activeTabType }
      const hasStateChange =
        s.activeWorktreeId !== worktreeId ||
        // Why: a pending-creation panel can be showing while activeWorktreeId is
        // still the prior worktree. Re-selecting that same worktree must clear
        // the panel, so a non-null activePendingCreationId counts as a change.
        s.activePendingCreationId !== null ||
        s.activeFileId !== activeFileId ||
        s.activeBrowserTabId !== activeBrowserTabId ||
        s.activeTabType !== activeTabType ||
        s.rightSidebarExplorerView !== restoredRightSidebarExplorerView ||
        s.activeTabId !== activeTabId ||
        nextActiveTabTypeByWorktree !== s.activeTabTypeByWorktree ||
        nextEverActivated !== s.everActivatedWorktreeIds ||
        nextWorktrees !== s.worktreesByRepo ||
        nextDetectedWorktrees !== s.detectedWorktreesByRepo
      if (!hasStateChange) {
        // Why: repeated activation of the already-active worktree can come from
        // clicks, IPC, and automation restore paths. Preserve the root Zustand
        // reference so session persistence/runtime sync do not fan out on a no-op.
        return s
      }

      return {
        activeWorktreeId: worktreeId,
        activeWorkspaceKey: worktreeWorkspaceKey(worktreeId),
        activePendingCreationId: null,
        activeFileId,
        activeBrowserTabId,
        activeTabType,
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
        rightSidebarExplorerView: restoredRightSidebarExplorerView,
        activeTabId,
        everActivatedWorktreeIds: nextEverActivated,
        ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {}),
        ...tabsByWorktreeUpdate
      }
    })

    if (worktreeId && shouldPrepareTerminalTabs) {
      const prepareTerminalTabs = (): void => {
        pendingActivationTerminalPrepCancels.delete(worktreeId)
        set((s) => {
          if (s.activeWorktreeId !== worktreeId) {
            return {}
          }
          const tabs = s.tabsByWorktree[worktreeId] ?? []
          if (tabs.length === 0) {
            return {}
          }
          const allDead = tabs.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
          if (!allDead && !shouldTagTerminalTabs) {
            return {}
          }
          return {
            tabsByWorktree: {
              ...s.tabsByWorktree,
              [worktreeId]: tabs.map((tab) => ({
                ...tab,
                ...(allDead ? { generation: (tab.generation ?? 0) + 1 } : {}),
                // Why: slept terminal remount/spawn is click-driven wake work.
                // Tag the resulting PTY updates so they do not reshuffle Recent.
                pendingActivationSpawn: getActivationSpawnSuppression(
                  s.terminalLayoutsByTabId[tab.id]
                )
              }))
            }
          }
        })
      }

      const cancelExistingPrep = pendingActivationTerminalPrepCancels.get(worktreeId)
      if (cancelExistingPrep) {
        cancelExistingPrep()
      }
      if (shouldDeferActivationTerminalPrep()) {
        pendingActivationTerminalPrepCancels.set(
          worktreeId,
          scheduleAfterInputQuiet(prepareTerminalTabs, {
            delayMs: ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
            quietMs: ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS,
            idleTimeoutMs: ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS
          })
        )
      } else {
        prepareTerminalTabs()
      }
    }

    // Why: activation is explicit enough to revalidate PR state immediately;
    // the GitHub coordinator still coalesces requests and applies rate guards.
    if (worktreeId) {
      get().refreshGitHubForWorktreeIfStale(worktreeId)
    }

    if (!worktreeId || !get().getKnownWorktreeById(worktreeId)) {
      return
    }

    if (shouldClearUnread) {
      const updates: Partial<WorktreeMeta> = {
        isUnread: false
      }

      void persistWorktreeMeta(
        settingsForWorktreeOwner(get(), worktreeId),
        worktreeId,
        updates
      ).catch((err) => {
        if (isRuntimeSelectorNotFoundError(err)) {
          void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
          return
        }
        console.error('Failed to persist worktree activation state:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
    }
  },

  setActiveFolderWorkspace: (folderWorkspaceId) => {
    const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
    const workspace = get().folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
    if (!workspace) {
      return
    }
    if (shouldDeferActivationTerminalPrep()) {
      markInputQuietSchedulerInput()
    }
    if (get().activeWorktreeId !== workspaceKey) {
      moveFocusToRendererBeforeFocusedWebviewHidden()
    }
    const reconciledActiveTabId =
      get().reconcileWorktreeTabModel(workspaceKey).activeRenderableTabId
    set((s) => {
      const restoredFileId = s.activeFileIdByWorktree[workspaceKey] ?? null
      const restoredBrowserTabId = s.activeBrowserTabIdByWorktree[workspaceKey] ?? null
      const restoredTabType = s.activeTabTypeByWorktree[workspaceKey] ?? 'terminal'
      const activeGroupId =
        s.activeGroupIdByWorktree[workspaceKey] ?? s.groupsByWorktree[workspaceKey]?.[0]?.id ?? null
      const activeGroup = activeGroupId
        ? ((s.groupsByWorktree[workspaceKey] ?? []).find((group) => group.id === activeGroupId) ??
          null)
        : null
      const activeUnifiedTabId = reconciledActiveTabId ?? activeGroup?.activeTabId ?? null
      const activeUnifiedTab =
        activeUnifiedTabId != null
          ? ((s.unifiedTabsByWorktree[workspaceKey] ?? []).find(
              (tab) =>
                tab.id === activeUnifiedTabId && (!activeGroup || tab.groupId === activeGroup.id)
            ) ?? null)
          : null
      const fileStillOpen = restoredFileId
        ? s.openFiles.some((file) => file.id === restoredFileId && file.worktreeId === workspaceKey)
        : false
      const browserTabs = s.browserTabsByWorktree[workspaceKey] ?? []
      const browserTabStillOpen = restoredBrowserTabId
        ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
        : false
      const worktreeTabs = s.tabsByWorktree[workspaceKey] ?? []
      const restoredTabId = s.activeTabIdByWorktree[workspaceKey] ?? null
      const tabStillExists = restoredTabId
        ? worktreeTabs.some((tab) => tab.id === restoredTabId)
        : false
      const activeFileId =
        activeUnifiedTab?.contentType === 'editor' ||
        activeUnifiedTab?.contentType === 'diff' ||
        activeUnifiedTab?.contentType === 'conflict-review' ||
        activeUnifiedTab?.contentType === 'check-details'
          ? activeUnifiedTab.entityId
          : fileStillOpen
            ? restoredFileId
            : null
      const activeBrowserTabId =
        activeUnifiedTab?.contentType === 'browser'
          ? activeUnifiedTab.entityId
          : browserTabStillOpen
            ? restoredBrowserTabId
            : (browserTabs[0]?.id ?? null)
      const activeTabType =
        activeUnifiedTab?.contentType === 'terminal'
          ? 'terminal'
          : activeUnifiedTab?.contentType === 'browser'
            ? 'browser'
            : activeUnifiedTab
              ? 'editor'
              : restoredTabType === 'browser' && browserTabStillOpen
                ? 'browser'
                : restoredTabType === 'editor' && fileStillOpen
                  ? 'editor'
                  : fileStillOpen
                    ? 'editor'
                    : browserTabs.length > 0
                      ? 'browser'
                      : 'terminal'
      const activeTabId =
        activeUnifiedTab?.contentType === 'terminal'
          ? activeUnifiedTab.entityId
          : tabStillExists
            ? restoredTabId
            : (worktreeTabs[0]?.id ?? null)
      const nextEverActivated = s.everActivatedWorktreeIds.has(workspaceKey)
        ? s.everActivatedWorktreeIds
        : new Set([...s.everActivatedWorktreeIds, workspaceKey])
      return {
        activeRepoId: null,
        activeWorktreeId: workspaceKey,
        activeWorkspaceKey: workspaceKey,
        activePendingCreationId: null,
        activeFileId,
        activeBrowserTabId,
        activeTabType,
        activeTabTypeByWorktree:
          s.activeTabTypeByWorktree[workspaceKey] === activeTabType
            ? s.activeTabTypeByWorktree
            : { ...s.activeTabTypeByWorktree, [workspaceKey]: activeTabType },
        activeTabId,
        everActivatedWorktreeIds: nextEverActivated,
        folderWorkspaces: workspace.isUnread
          ? s.folderWorkspaces.map((entry) =>
              entry.id === folderWorkspaceId ? { ...entry, isUnread: false } : entry
            )
          : s.folderWorkspaces
      }
    })
    if (workspace.isUnread) {
      void get().updateFolderWorkspace(folderWorkspaceId, { isUnread: false })
    }
  },

  allWorktrees: () => Object.values(get().worktreesByRepo).flat(),

  getKnownWorktreeById: (worktreeId) => findKnownWorktreeById(get(), worktreeId),

  purgeWorktreeTerminalState: (worktreeIds: string[]) => {
    const purgeableWorktreeIds = worktreeIds.filter((id) => id !== FLOATING_TERMINAL_WORKTREE_ID)
    if (purgeableWorktreeIds.length === 0) {
      return
    }
    set((s) => buildWorktreePurgeState(s, purgeableWorktreeIds))
  },

  migrateWorktreeIdentity: (oldWorktreeId: string, newWorktreeId: string) => {
    if (oldWorktreeId === newWorktreeId) {
      return
    }
    set((s) => buildWorktreeRenameState(s, oldWorktreeId, newWorktreeId))
    migrateHostedReviewLinkMutationGeneration(oldWorktreeId, newWorktreeId)
  }
})
