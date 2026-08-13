/* eslint-disable max-lines */
import type { StateCreator, StoreApi } from 'zustand'
import type { AppState } from '../types'
import type {
  DetectedWorktreeListResult,
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
  ProjectHostSetup,
  Repo,
  WorktreeMeta
} from '../../../../shared/types'
import type { RuntimeWorktreeListResult } from '../../../../shared/runtime-types'
import {
  findWorktreeById,
  applyWorktreeUpdates,
  withoutErasedRequiredWorktreeFields,
  getRepoIdFromWorktreeId,
  type DirectSshWorktreeFetchOptions,
  type WorktreeFetchOptions,
  type WorktreeSlice
} from './worktree-helpers'
import { projectWorktreeTabModelReconciliation } from './tabs'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'
import {
  remapClosedTerminalTabSnapshotCwds,
  type ClosedTerminalTabSnapshot
} from './recently-closed-tabs'
import { findRepoForHost } from './repo-host-identity'
import {
  dropWorktreeRowsForRemovedRuntimeEnvironments,
  isRemovedRuntimeHostId
} from './stale-runtime-host-rows'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { disposeRemovedWorktreeParkedTerminalWatchers } from '../../components/terminal-pane/terminal-parked-watcher-registry'
import {
  callRuntimeRpc,
  assertRuntimeEnvironmentCapability,
  getActiveRuntimeTarget,
  hasRuntimeRpcErrorCode,
  isRuntimeScopeForbiddenError,
  RuntimeRpcCallError
} from '../../runtime/runtime-rpc-client'
import {
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { getHostedReviewCacheKey, refreshHostedReviewCard } from './hosted-review'
import { routeListingBranchSwitchesThroughGitIdentity } from './worktree-listing-branch-switch'
import { isPositiveHostedReviewNumber } from '../../../../shared/hosted-review'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from './github-cache-key'
import { moveFocusToRendererBeforeFocusedWebviewHidden } from './browser-webview-cleanup'
import { toast } from 'sonner'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-hibernation-output-activity'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
import { forgetAgentPaneAuthorityAliasesByTabIds } from './agent-pane-authority'
import { branchName } from '@/lib/git-utils'
import { markInputQuietSchedulerInput, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import { clearSessionCommitDraftForWorktree } from '@/lib/source-control-commit-draft-session'
import {
  forgetHugeRepoWarningDismissalsForWorktrees,
  migrateHugeRepoWarningDismissal
} from '@/lib/source-control-huge-repo-warning-dismissals'
import { showLocalBaseRefUpdateSuggestionToast } from '@/components/sidebar/local-base-ref-suggestion-toast'
import { showPreservedBranchToast } from '@/components/sidebar/preserved-branch-toast'
import { requestWorktreeBaseFallbackNotice } from '@/components/worktree-base-fallback-notice'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteResult,
  settingsForWorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'
import { getEnvironmentSshStateGeneration } from './runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from './runtime-status'
import {
  folderWorkspaceKey,
  getActiveSidebarWorkspaceId,
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  isRetryableWorktreeCreateConflict
} from '../../../../shared/new-workspace/worktree-create-retry-policy'
import {
  classifyWorktreeForceDeleteReason,
  getLockedWorktreeRemovalReason,
  isLockedWorktreeRemovalError
} from '../../../../shared/worktree-removal'
import { FolderWorkspaceActivityPersistence } from './folder-workspace-activity-persistence'
import {
  createDetectedWorktreeRefreshLeaseRegistry,
  type DetectedWorktreeRefreshLease
} from './detected-worktree-refresh-leases'
import { getTerminalActivationSpawnSuppression } from './terminal-activation-spawn-suppression'
import {
  preservedBranchCleanupKey,
  type PreservedBranchCleanup
} from '../../../../shared/preserved-branch-cleanup'
import type {
  HostQualifiedDetectedWorktreeResult,
  HostQualifiedKnownWorktreeResult,
  ListDetectedWorktreesArgs,
  ProviderRequestId,
  SshExecutionHostId
} from '../../../../shared/detected-worktree-provider-contract'
import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { catalogRowsEqual, reuseEqualCatalogRows } from './worktree-catalog-reconciliation'
import { reuseEqualRecordMap } from './repo-identity-reconcile'
export type { WorktreeSlice, WorktreeDeleteState } from './worktree-helpers'

// Why: old runtime servers only have `worktree.list`; preserve the large-list UI hydration parity used before `worktree.detectedList` existed.
const REMOTE_WORKTREE_LIST_PARITY_LIMIT = 10_000
const WORKTREE_REMOVAL_AMBIGUOUS_ERROR =
  'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
const ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS = 300
const ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS = 450
const ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS = 180
const FOLDER_WORKSPACE_ACTIVITY_PERSIST_INTERVAL_MS = 1_000
// Why: each repo's `git worktree list` is an independent main-process child; a higher ceiling cuts startup scan batches (#7225) while staying bounded against launching every git probe at once.
export const WORKTREE_REFRESH_CONCURRENCY = 8
const pendingActivationTerminalPrepCancels = new Map<string, () => void>()
const detachedHeadAutoDerivedDisplayNames = new Map<string, string>()
const preservedBranchRuntimeTargetByCleanupKey = new Map<
  string,
  { cleanup: PreservedBranchCleanup; target: ReturnType<typeof getActiveRuntimeTarget> }
>()
const folderWorkspaceWorktreeCache = new WeakMap<FolderWorkspace, Worktree>()
const hostedReviewPushTargetLookupsInFlight = new Set<string>()
const runtimeDetectedWorktreeRefreshesInFlight = new Map<
  string,
  Promise<DetectedWorktreeListResult>
>()
type WorktreeSliceGet = Parameters<StateCreator<AppState>>[1]
const folderWorkspaceActivityPersistenceByStore = new WeakMap<
  WorktreeSliceGet,
  FolderWorkspaceActivityPersistence
>()

function getFolderWorkspaceActivityPersistence(
  get: WorktreeSliceGet
): FolderWorkspaceActivityPersistence {
  const existing = folderWorkspaceActivityPersistenceByStore.get(get)
  if (existing) {
    return existing
  }
  const created = new FolderWorkspaceActivityPersistence((folderWorkspaceId, activityAt) => {
    if (get().folderWorkspaces.some((workspace) => workspace.id === folderWorkspaceId)) {
      void get().updateFolderWorkspace(folderWorkspaceId, { lastActivityAt: activityAt })
    }
  }, FOLDER_WORKSPACE_ACTIVITY_PERSIST_INTERVAL_MS)
  folderWorkspaceActivityPersistenceByStore.set(get, created)
  return created
}

type BackgroundRuntimeRefreshOptions = {
  reuseRecentCompatibilityFailure?: boolean
}

type DetectedWorktreeRefreshOptions = BackgroundRuntimeRefreshOptions & {
  executionHostId: ExecutionHostId
  requireAuthoritative?: boolean
  directSshAuthority?: DirectSshAuthority
  // Why (#10562): the caller's own view of what it is about to purge. Teardown is
  // requested per caller, so this must never be shared with a coalesced scan.
  connectionId?: string | null
  knownWorktreeIds?: readonly string[]
}

type AdmittedDetectedWorktreeRefresh = {
  status: 'admitted'
  result: DetectedWorktreeListResult
  providerResult?: HostQualifiedDetectedWorktreeResult
  executionHostId: ExecutionHostId
  directSshAuthority?: DirectSshAuthority
  runtimeAuthority?: {
    environmentId: string
    connectionGeneration: number
    runtimeConnectionGeneration: number
  }
}

type DetectedWorktreeRefreshOutcome =
  | AdmittedDetectedWorktreeRefresh
  | {
      status: 'not-admitted'
      providerResult: HostQualifiedDetectedWorktreeResult
      executionHostId: ExecutionHostId
      directSshAuthority?: DirectSshAuthority
    }

async function mapReposForWorktreeRefresh<TRepo extends { id: string }, TResult>(
  repos: readonly TRepo[],
  mapper: (repo: TRepo) => Promise<TResult>
): Promise<TResult[]> {
  const results = Array<TResult>(repos.length)
  let nextIndex = 0
  const workerCount = Math.min(WORKTREE_REFRESH_CONCURRENCY, repos.length)

  // Why: refresh can fire during activation/startup; bound repo scans so one UI moment can't launch every git probe at once.
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

function shouldDeferActivationTerminalPrep(): boolean {
  return typeof window !== 'undefined' && import.meta.env.MODE !== 'test'
}

function localBaseRefRefreshFailureDetail(result: LocalBaseRefRefreshResult): string {
  const ownerWorktreePath = result.ownerWorktreePath?.trim()
  switch (result.status) {
    case 'skipped_dirty_worktree':
      // Create already succeeded — guide cleanup + manual base update, not "try again".
      return ownerWorktreePath
        ? translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirtyNamed',
            'The worktree at {{value0}} (where local {{value1}} is checked out) has uncommitted changes. Commit, stash, or discard those changes, then update local {{value1}} manually.',
            { value0: ownerWorktreePath, value1: result.localBranch }
          )
        : translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirty',
            'The worktree where local {{value0}} is checked out has uncommitted changes. Commit, stash, or discard those changes, then update local {{value0}} manually.',
            { value0: result.localBranch }
          )
    case 'skipped_not_fast_forward':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailNotFastForward',
        'Local {{value0}} does not exist or cannot be fast-forwarded cleanly from the remote base. Check for local-only commits before updating it manually.',
        { value0: result.localBranch }
      )
    case 'skipped_error':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailError',
        'Git returned an error while updating local {{value0}}. Check the repo for locked refs or unusual worktree state, then update local {{value0}} manually.',
        { value0: result.localBranch }
      )
    case 'updated':
      return ''
  }
}

function showLocalBaseRefRefreshToast(
  result: LocalBaseRefRefreshResult | undefined,
  createdWorktree?: Pick<Worktree, 'id' | 'displayName' | 'branch' | 'path'>
): void {
  if (!result || result.status === 'updated') {
    return
  }

  const worktreeName = createdWorktree ? resolveWorktreeDisplayName(createdWorktree).trim() : ''
  const detail = localBaseRefRefreshFailureDetail(result)

  // Why: Infinity so create-time failures aren't buried; id is per worktree so each create stays attributable.
  toast.warning(
    worktreeName
      ? translate(
          'auto.store.slices.worktrees.localBaseRefRefreshFailedForWorktree',
          'Local {{value0}} was not refreshed for "{{value1}}"',
          { value0: result.localBranch, value1: worktreeName }
        )
      : translate('auto.store.slices.worktrees.14bc053a47', 'Local {{value0}} was not refreshed', {
          value0: result.localBranch
        }),
    {
      id: `local-base-ref-refresh-failed:${createdWorktree?.id ?? 'unknown'}:${result.localBranch}`,
      description: worktreeName
        ? translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDescriptionNamed',
            'Workspace "{{value0}}" was created from {{value1}}, but Orca could not fast-forward local {{value2}}. {{value3}}',
            {
              value0: worktreeName,
              value1: result.baseRef,
              value2: result.localBranch,
              value3: detail
            }
          )
        : translate(
            'auto.store.slices.worktrees.903b51c2ed',
            'Workspace created from {{value0}}, but Orca could not fast-forward local {{value1}}. {{value2}}',
            { value0: result.baseRef, value1: result.localBranch, value2: detail }
          ),
      duration: Infinity,
      dismissible: true
    }
  )
}

function areWorktreesEqual(current: Worktree[] | undefined, next: Worktree[]): boolean {
  return catalogRowsEqual(current, next)
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
    catalogRowsEqual(current.worktrees, next.worktrees)
  )
}

function toVisibleTabType(contentType: string): WorkspaceVisibleTabType {
  if (contentType === 'browser' || contentType === 'terminal' || contentType === 'simulator') {
    return contentType
  }
  return 'editor'
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

// Why: runtime payloads describe execution from the HUB's perspective; project that location without losing the paired transport owner.
function withRepoHostOwnership<
  T extends {
    hostId?: ExecutionHostId
    runtimeOwnerEnvironmentId?: string
    projectId?: string
    projectHostSetupId?: string
  }
>(worktree: T, hostId: ExecutionHostId, setup?: ProjectHostSetup): T {
  const parsedOwner = parseExecutionHostId(hostId)
  const runtimeOwnerEnvironmentId =
    parsedOwner?.kind === 'runtime' ? parsedOwner.environmentId : undefined
  const worktreeHost = parseExecutionHostId(worktree.hostId)
  // Why: an SSH worktree reached through a paired HUB has two owners; retain the SSH execution host and stamp the HUB transport separately.
  const nextHostId =
    hostId === LOCAL_EXECUTION_HOST_ID ||
    (runtimeOwnerEnvironmentId !== undefined && worktreeHost?.kind === 'ssh')
      ? worktree.hostId
      : hostId
  const projectId = worktree.projectId ?? setup?.projectId
  const projectHostSetupId = worktree.projectHostSetupId ?? setup?.id
  if (
    nextHostId === worktree.hostId &&
    runtimeOwnerEnvironmentId === worktree.runtimeOwnerEnvironmentId &&
    projectId === worktree.projectId &&
    projectHostSetupId === worktree.projectHostSetupId
  ) {
    return worktree
  }
  return {
    ...worktree,
    ...(nextHostId ? { hostId: nextHostId } : {}),
    runtimeOwnerEnvironmentId,
    ...(projectId ? { projectId } : {}),
    ...(projectHostSetupId ? { projectHostSetupId } : {})
  } as T
}

function repoHostId(
  state: Pick<AppState, 'repos' | 'settings'>,
  repoId: string,
  hostId?: ExecutionHostId | null
): ExecutionHostId {
  const repo = findRepoForHost(state.repos, repoId, { hostId, settings: state.settings })
  if (repo) {
    return getRepoExecutionHostId(repo)
  }
  return hostId && parseExecutionHostId(hostId) ? hostId : LOCAL_EXECUTION_HOST_ID
}

function repoHasExactlyOneExecutionHostOwner(
  state: Pick<AppState, 'repos'>,
  repoId: string,
  hostId: ExecutionHostId,
  ownerWasMissingAtStart: boolean
): boolean {
  const repoOwners = state.repos.filter((repo) => repo.id === repoId)
  if (repoOwners.length === 0) {
    return ownerWasMissingAtStart
  }
  const ownerHostIds = repoOwners.map((repo) => {
    const hasExplicitHost = repo.executionHostId !== null && repo.executionHostId !== undefined
    const explicitHost = hasExplicitHost ? parseExecutionHostId(repo.executionHostId) : null
    if (hasExplicitHost && !explicitHost) {
      return null
    }
    const rawConnectionId = repo.connectionId
    const hasConnection = rawConnectionId !== null && rawConnectionId !== undefined
    const connectionId = hasConnection ? rawConnectionId.trim() : null
    if (hasConnection && !connectionId) {
      return null
    }
    if (!connectionId || explicitHost?.kind === 'runtime') {
      return explicitHost?.id ?? LOCAL_EXECUTION_HOST_ID
    }
    if (explicitHost && explicitHost.id !== toSshExecutionHostId(connectionId)) {
      return null
    }
    return explicitHost?.id ?? toSshExecutionHostId(connectionId)
  })
  return (
    ownerHostIds.every((ownerHostId) => ownerHostId !== null) &&
    ownerHostIds.filter((ownerHostId) => ownerHostId === hostId).length === 1
  )
}

function toVisibleWorktrees(
  result: DetectedWorktreeListResult,
  hostId: ExecutionHostId,
  setup?: ProjectHostSetup
): Worktree[] {
  return result.worktrees
    .filter((worktree) => worktree.visible)
    .map(toVisibleWorktree)
    .map((worktree) => withRepoHostOwnership(worktree, hostId, setup))
}

function getProjectHostSetupForRepoHost(
  state: Partial<Pick<AppState, 'projectHostSetups'>>,
  repoId: string,
  hostId: ExecutionHostId
): ProjectHostSetup | undefined {
  return state.projectHostSetups?.find(
    (setup) => setup.repoId === repoId && setup.hostId === hostId
  )
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
    // Why: pre-host persisted runtime/SSH worktrees lack hostId; treat them as the sole repo owner's rows but keep ambiguous duplicates local.
    unhostedWorktreesMatchHost: unhostedWorktreesMatchRefreshHost(state, repoId, hostId)
  }
}

function worktreeMatchesHost(
  worktree: { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string },
  hostId: ExecutionHostId,
  options: WorktreeHostMatchOptions = {}
): boolean {
  const parsedRefreshHost = parseExecutionHostId(hostId)
  if (parsedRefreshHost?.kind === 'runtime') {
    if (worktree.runtimeOwnerEnvironmentId) {
      return worktree.runtimeOwnerEnvironmentId === parsedRefreshHost.environmentId
    }
    if (worktree.hostId) {
      return worktree.hostId === hostId
    }
    return options.unhostedWorktreesMatchHost ?? false
  }
  if (worktree.runtimeOwnerEnvironmentId) {
    return false
  }
  if (worktree.hostId) {
    return worktree.hostId === hostId
  }
  return options.unhostedWorktreesMatchHost ?? hostId === LOCAL_EXECUTION_HOST_ID
}

function mergeWorktreesForHost<
  T extends { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
>(
  current: readonly T[] | undefined,
  refreshed: readonly T[],
  hostId: ExecutionHostId,
  options?: WorktreeHostMatchOptions
): T[] {
  // Why: host-scoped refreshes replace that host in place so alternating local/runtime refreshes don't churn sibling row order or sortEpoch.
  const existing = current ?? []
  const reconciled = reuseEqualCatalogRows(
    existing.filter((worktree) => worktreeMatchesHost(worktree, hostId, options)),
    refreshed
  )
  const next: T[] = []
  let inserted = false

  for (const worktree of existing) {
    if (worktreeMatchesHost(worktree, hostId, options)) {
      if (!inserted) {
        next.push(...reconciled)
        inserted = true
      }
      continue
    }
    next.push(worktree)
  }

  if (!inserted) {
    next.push(...reconciled)
  }
  return existing.length === next.length && existing.every((row, index) => row === next[index])
    ? (existing as T[])
    : next
}

function mergeDetectedWorktreesForHost(
  current: DetectedWorktreeListResult | undefined,
  refreshed: DetectedWorktreeListResult,
  hostId: ExecutionHostId,
  setup?: ProjectHostSetup,
  options?: WorktreeHostMatchOptions
): DetectedWorktreeListResult {
  const refreshedForHost = sanitizeHostedReviewLinksForBranchClears(
    refreshed.worktrees,
    current?.worktrees
  ).map((worktree) => withRepoHostOwnership(worktree, hostId, setup))
  const worktrees = mergeWorktreesForHost(current?.worktrees, refreshedForHost, hostId, options)
  if (
    current &&
    current.repoId === refreshed.repoId &&
    current.authoritative === refreshed.authoritative &&
    current.source === refreshed.source &&
    current.worktrees === worktrees
  ) {
    return current
  }
  return {
    ...refreshed,
    worktrees
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
    // Why (#1158): hydration can preserve tab keys before worktree metadata exists; the first authoritative scan must still reap deleted session-only keys.
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

// Why: teardown cannot ride the scan's coalescing (each caller has its own known-id
// snapshot), so dedupe on the request it actually produces — identical fan-out
// requests share one host sweep instead of re-scanning per caller.
const missingWorktreeTeardownsInFlight = new Map<string, Promise<void>>()

async function teardownMissingWorktreeTerminalsBestEffort(
  settings: AppState['settings'],
  repoId: string,
  connectionId: string | null | undefined,
  // Why: refreshes that never purge omit this; an absent snapshot means
  // "nothing to reconcile", never "purge everything".
  knownWorktreeIds: readonly string[] | undefined,
  detected: DetectedWorktreeListResult
): Promise<void> {
  if (!detected.authoritative || !knownWorktreeIds || knownWorktreeIds.length === 0) {
    return
  }
  const detectedIds = new Set(detected.worktrees.map((worktree) => worktree.id))
  const missingIds = knownWorktreeIds.filter((worktreeId) => !detectedIds.has(worktreeId))
  if (missingIds.length === 0) {
    return
  }
  const target = getActiveRuntimeTarget(settings)
  const normalizedConnectionId = connectionId ?? null
  const key = [
    target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`,
    repoId,
    normalizedConnectionId ?? '',
    [...missingIds].sort().join('\n')
  ].join('\0')
  const existing = missingWorktreeTeardownsInFlight.get(key)
  if (existing) {
    return existing
  }
  const teardown = (async () => {
    try {
      await callRuntimeRpc(
        target,
        'worktree.teardownMissingTerminals',
        { repo: repoId, worktreeIds: missingIds, connectionId: normalizedConnectionId },
        { timeoutMs: 30_000 }
      )
    } catch (error) {
      if (!isRuntimeMethodNotFoundError(error)) {
        console.warn(`Failed to stop terminals for missing worktrees in repo ${repoId}:`, error)
      }
    }
  })()
  missingWorktreeTeardownsInFlight.set(key, teardown)
  try {
    await teardown
  } finally {
    if (missingWorktreeTeardownsInFlight.get(key) === teardown) {
      missingWorktreeTeardownsInFlight.delete(key)
    }
  }
}

// Why: a mobile-scope web pairing is denied worktree/repo RPCs (else silently empty workspaces); surface one deduped toast (stable id) instead of spamming per-repo.
const RUNTIME_SCOPE_FORBIDDEN_TOAST_ID = 'runtime-scope-forbidden'

function notifyRuntimeScopeForbiddenIfNeeded(error: unknown): boolean {
  if (!isRuntimeScopeForbiddenError(error)) {
    return false
  }
  toast.error(
    translate(
      'auto.store.slices.worktrees.runtimeScopeForbiddenTitle',
      'This connection has limited (mobile) access'
    ),
    {
      id: RUNTIME_SCOPE_FORBIDDEN_TOAST_ID,
      description: translate(
        'auto.store.slices.worktrees.runtimeScopeForbiddenDescription',
        'Workspaces are unavailable on a mobile-scope pairing. Reconnect using the browser access link from Settings → Runtime Environments → Share this Orca server.'
      )
    }
  )
  return true
}

function applyDetectedWorktreeUpdates(
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo'],
  worktreeId: string,
  rawUpdates: Partial<WorktreeMeta>
): AppState['detectedWorktreesByRepo'] {
  // Why: mirrors applyWorktreeUpdates — detected rows feed the same palette.
  const updates = withoutErasedRequiredWorktreeFields(rawUpdates)
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

function folderWorkspaceMatchesHost(
  workspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  executionHostId: ExecutionHostId
): boolean {
  return (
    (parseExecutionHostId(workspace.executionHostId)?.id ??
      (workspace.connectionId?.trim()
        ? toSshExecutionHostId(workspace.connectionId)
        : LOCAL_EXECUTION_HOST_ID)) === executionHostId
  )
}

function findKnownWorktreeById(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'>,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (workspace) =>
        workspace.id === workspaceScope.folderWorkspaceId &&
        (!executionHostId || folderWorkspaceMatchesHost(workspace, executionHostId))
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
  const visible = executionHostId
    ? (findIndexedWorktreeOwnerForHost(
        state.worktreesByRepo,
        worktreeId,
        executionHostId
      ) as Worktree | null)
    : findWorktreeById(state.worktreesByRepo, worktreeId)
  if (visible) {
    return visible
  }
  for (const result of Object.values(state.detectedWorktreesByRepo)) {
    const detected = result.worktrees.find(
      (worktree) =>
        worktree.id === worktreeId &&
        (!executionHostId ||
          worktreeMatchesHost(worktree, executionHostId, {
            unhostedWorktreesMatchHost: executionHostId === LOCAL_EXECUTION_HOST_ID
          }))
    )
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
    | 'diffComments'
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
      | 'diffComments'
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
  if (updates.diffComments !== undefined) {
    next.diffComments = updates.diffComments
  }
  return next
}

function isRuntimeSelectorNotFoundError(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'selector_not_found')
}

function isRuntimeRepoNotFoundError(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'repo_not_found')
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
  hostId?: ExecutionHostId | null,
  honorMissingHostId = false
) {
  const repo = findRepoForHost(state.repos, repoId, { hostId, settings: state.settings })
  if (repo) {
    return settingsForKnownRepoOwner(state.settings, repo)
  }
  const parsedHost = honorMissingHostId && hostId ? parseExecutionHostId(hostId) : null
  if (parsedHost?.kind === 'runtime') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: parsedHost.environmentId }
      : ({ activeRuntimeEnvironmentId: parsedHost.environmentId } as AppState['settings'])
  }
  if (parsedHost?.kind === 'local' || parsedHost?.kind === 'ssh') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: null }
      : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
  }
  return state.settings
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
  // Why: SSH repos are owned by the desktop client/SSH provider, not the focused runtime server.
  return settings
    ? { ...settings, activeRuntimeEnvironmentId: null }
    : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
}

function trySettingsForWorktreeOwner(
  state: Pick<
    AppState,
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'restoredRuntimeHostIdByWorkspaceSessionKey'
    | 'runtimeEnvironments'
    | 'runtimeEnvironmentCatalogHydrated'
    | 'removedRuntimeEnvironmentIds'
  >,
  worktreeId: string
): AppState['settings'] | null {
  const route = resolveWorktreeOperationRoute(state, worktreeId)
  if (!route) {
    return null
  }
  return settingsForWorktreeOperationRoute(state.settings, route)
}

function settingsForWorktreeOwner(
  state: Parameters<typeof trySettingsForWorktreeOwner>[0],
  worktreeId: string
) {
  const settings = trySettingsForWorktreeOwner(state, worktreeId)
  if (!settings) {
    throw new Error(WORKTREE_REMOVAL_AMBIGUOUS_ERROR)
  }
  return settings
}

// Why: activity bumps fire on every PTY event, so an ambiguous workspace would warn continuously.
// One line per workspace is enough to diagnose it (#10634).
const ambiguousOwnerWarnedWorktreeIds = new Set<string>()

function warnAmbiguousOwnerOnce(worktreeId: string, errorLabel: string): void {
  if (ambiguousOwnerWarnedWorktreeIds.has(worktreeId)) {
    return
  }
  ambiguousOwnerWarnedWorktreeIds.add(worktreeId)
  console.warn(`Skipped ${errorLabel}: workspace identity is ambiguous across hosts`, worktreeId)
}

function persistPassiveWorktreeMetaForOwner(
  get: WorktreeSliceGet,
  worktreeId: string,
  updates: Partial<WorktreeMeta>,
  errorLabel: string
): void {
  const ownerSettings = trySettingsForWorktreeOwner(get(), worktreeId)
  if (!ownerSettings) {
    warnAmbiguousOwnerOnce(worktreeId, errorLabel)
    return
  }
  void persistWorktreeMeta(ownerSettings, worktreeId, updates).catch((err) => {
    if (isRuntimeSelectorNotFoundError(err)) {
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      return
    }
    console.error(`Failed to ${errorLabel}:`, err)
    void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
  })
}

async function listDetectedWorktreesForRepo(
  settings: AppState['settings'],
  repoId: string,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<DetectedWorktreeListResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    throw new Error('Local detected-worktree reads require a provider lease')
  }
  try {
    return await callRuntimeRpc<DetectedWorktreeListResult>(
      target,
      'worktree.detectedList',
      { repo: repoId },
      {
        timeoutMs: 15_000,
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      }
    )
  } catch (error) {
    if (!isRuntimeMethodNotFoundError(error)) {
      throw error
    }
    const legacy = await callRuntimeRpc<RuntimeWorktreeListResult>(
      target,
      'worktree.list',
      { repo: repoId, limit: REMOTE_WORKTREE_LIST_PARITY_LIMIT },
      {
        timeoutMs: 15_000,
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      }
    )
    return toLegacyDetectedWorktreeResult(repoId, legacy)
  }
}

function detectedWorktreeRefreshKey(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): string {
  const target = getActiveRuntimeTarget(settings)
  const targetKey = target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`
  const parts = [
    repoId,
    options.executionHostId,
    targetKey,
    options.requireAuthoritative === true ? 'authoritative' : 'best-effort'
  ]
  // Why: only remote targets run a compat preflight, so a foreground (reuse:false) refresh must re-probe not coalesce onto a stale-failure background scan; local targets have no preflight and stay coalesced.
  if (target.kind === 'environment') {
    parts.push(`connection:${getEnvironmentSshStateGeneration(target.environmentId)}`)
    parts.push(`runtime:${getRuntimeEnvironmentConnectionGeneration(target.environmentId)}`)
    parts.push(options.reuseRecentCompatibilityFailure === true ? 'reuse-failure' : 'reprobe')
  }
  return parts.join('\n')
}

function isDetectedWorktreeListResult(value: unknown): value is DetectedWorktreeListResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const result = value as Partial<DetectedWorktreeListResult>
  return (
    typeof result.repoId === 'string' &&
    typeof result.authoritative === 'boolean' &&
    (result.source === 'git' ||
      result.source === 'metadata-fallback' ||
      result.source === 'session-fallback') &&
    Array.isArray(result.worktrees)
  )
}

function rejectedDetectedWorktreeProviderResult(
  request: ListDetectedWorktreesArgs
): HostQualifiedDetectedWorktreeResult {
  return {
    providerRequestId: request.providerRequestId,
    executionHostId: request.executionHostId,
    status: 'rejected'
  }
}

async function startDetectedWorktreeProviderRequest(
  request: ListDetectedWorktreesArgs
): Promise<HostQualifiedDetectedWorktreeResult> {
  const worktreesApi = window.api.worktrees as typeof window.api.worktrees & {
    listDetected?: typeof window.api.worktrees.listDetected
  }
  if (typeof worktreesApi.listDetected !== 'function') {
    if (request.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return rejectedDetectedWorktreeProviderResult(request)
    }
    const worktrees = await worktreesApi.list({ repoId: request.repoId })
    return {
      status: 'complete',
      providerRequestId: request.providerRequestId,
      repoId: request.repoId,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      result: toLegacyDetectedWorktreeResult(request.repoId, { worktrees })
    }
  }
  const result = await worktreesApi.listDetected(request)
  if (result && typeof result === 'object' && 'status' in result && 'providerRequestId' in result) {
    return result as unknown as HostQualifiedDetectedWorktreeResult
  }
  // Why: web and older preload implementations return the legacy local shape.
  if (request.executionHostId === LOCAL_EXECUTION_HOST_ID && isDetectedWorktreeListResult(result)) {
    return {
      status: result.authoritative ? 'complete' : 'non-authoritative',
      providerRequestId: request.providerRequestId,
      repoId: request.repoId,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      result
    }
  }
  return rejectedDetectedWorktreeProviderResult(request)
}

const detectedWorktreeRefreshLeaseRegistry = createDetectedWorktreeRefreshLeaseRegistry({
  startProviderRequest: startDetectedWorktreeProviderRequest,
  cancelProviderRequest: async (request) => {
    await window.api.worktrees.cancelListDetected?.({
      providerRequestId: request.providerRequestId
    })
  }
})

export function acquireDetectedWorktreeRefreshLeaseForRepo(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): DetectedWorktreeRefreshLease {
  const parsedHost = parseExecutionHostId(options.executionHostId)
  if (!parsedHost || parsedHost.kind === 'runtime') {
    throw new Error('Provider leases require a local or direct SSH execution host')
  }
  const publicKey = detectedWorktreeRefreshKey(settings, repoId, options)
  if (parsedHost.kind === 'local') {
    return detectedWorktreeRefreshLeaseRegistry.acquire(publicKey, {
      repoId,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  }
  if (
    !options.directSshAuthority ||
    !directSshAuthorityIsComplete(options.directSshAuthority, parsedHost.targetId)
  ) {
    throw new Error('Direct SSH provider leases require exact target authority')
  }
  return detectedWorktreeRefreshLeaseRegistry.acquire(publicKey, {
    repoId,
    executionHostId: options.executionHostId as SshExecutionHostId,
    expectedAuthority: { ...options.directSshAuthority }
  })
}

function qualifiedProviderResultIsAdmitted(
  result: HostQualifiedDetectedWorktreeResult,
  providerRequestId: ProviderRequestId,
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): result is Extract<
  HostQualifiedDetectedWorktreeResult,
  { status: 'complete' | 'non-authoritative' }
> {
  if (
    result.providerRequestId !== providerRequestId ||
    (result.status !== 'complete' && result.status !== 'non-authoritative') ||
    !isDetectedWorktreeListResult(result.result) ||
    !result.authority ||
    result.repoId !== repoId ||
    result.result.repoId !== repoId ||
    result.result.authoritative !== (result.status === 'complete')
  ) {
    return false
  }
  const parsedHost = parseExecutionHostId(options.executionHostId)
  if (parsedHost?.kind === 'local') {
    return (
      result.authority.kind === 'local' &&
      result.authority.executionHostId === LOCAL_EXECUTION_HOST_ID
    )
  }
  const expected = options.directSshAuthority
  return (
    parsedHost?.kind === 'ssh' &&
    expected !== undefined &&
    result.authority.kind === 'direct-ssh' &&
    result.authority.executionHostId === options.executionHostId &&
    result.authority.targetId === expected.targetId &&
    result.authority.providerEpoch === expected.providerEpoch &&
    result.authority.connectionGeneration === expected.connectionGeneration
  )
}

function normalizeNotAdmittedProviderResult(
  result: HostQualifiedDetectedWorktreeResult,
  providerRequestId: ProviderRequestId,
  executionHostId: ExecutionHostId
): HostQualifiedDetectedWorktreeResult {
  if (
    result.providerRequestId === providerRequestId &&
    result.status !== 'complete' &&
    result.status !== 'non-authoritative' &&
    'executionHostId' in result &&
    result.executionHostId === executionHostId
  ) {
    return result
  }
  return {
    providerRequestId,
    executionHostId,
    status: 'rejected'
  }
}

async function listDetectedWorktreesForRepoCoalesced(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): Promise<DetectedWorktreeRefreshOutcome> {
  const key = detectedWorktreeRefreshKey(settings, repoId, options)
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    const connectionGeneration = getEnvironmentSshStateGeneration(target.environmentId)
    const runtimeConnectionGeneration = getRuntimeEnvironmentConnectionGeneration(
      target.environmentId
    )
    let refresh = runtimeDetectedWorktreeRefreshesInFlight.get(key)
    if (!refresh) {
      refresh = listDetectedWorktreesForRepo(settings, repoId, {
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      })
      runtimeDetectedWorktreeRefreshesInFlight.set(key, refresh)
    }
    try {
      const result = await refresh
      if (
        getEnvironmentSshStateGeneration(target.environmentId) !== connectionGeneration ||
        getRuntimeEnvironmentConnectionGeneration(target.environmentId) !==
          runtimeConnectionGeneration
      ) {
        throw new Error('runtime_environment_generation_changed')
      }
      // Why (#10562): the scan coalesces, but teardown must not — each caller carries
      // its own known-id snapshot and purges its own state, so a caller that joined
      // an in-flight scan would otherwise purge without ever stopping those terminals.
      await teardownMissingWorktreeTerminalsBestEffort(
        settings,
        repoId,
        options.connectionId,
        options.knownWorktreeIds,
        result
      )
      return {
        status: 'admitted',
        result,
        executionHostId: options.executionHostId,
        runtimeAuthority: {
          environmentId: target.environmentId,
          connectionGeneration,
          runtimeConnectionGeneration
        }
      }
    } finally {
      if (runtimeDetectedWorktreeRefreshesInFlight.get(key) === refresh) {
        runtimeDetectedWorktreeRefreshesInFlight.delete(key)
      }
    }
  }

  const lease = acquireDetectedWorktreeRefreshLeaseForRepo(settings, repoId, options)
  let providerResult: HostQualifiedDetectedWorktreeResult
  try {
    providerResult = await lease.result
  } catch {
    return {
      status: 'not-admitted',
      providerResult: {
        providerRequestId: lease.providerRequestId,
        executionHostId: options.executionHostId,
        status: 'rejected'
      },
      executionHostId: options.executionHostId,
      directSshAuthority: options.directSshAuthority
    }
  }
  if (
    !qualifiedProviderResultIsAdmitted(providerResult, lease.providerRequestId, repoId, options)
  ) {
    return {
      status: 'not-admitted',
      providerResult: normalizeNotAdmittedProviderResult(
        providerResult,
        lease.providerRequestId,
        options.executionHostId
      ),
      executionHostId: options.executionHostId,
      directSshAuthority: options.directSshAuthority
    }
  }
  await teardownMissingWorktreeTerminalsBestEffort(
    settings,
    repoId,
    options.connectionId,
    options.knownWorktreeIds,
    providerResult.result
  )
  return {
    status: 'admitted',
    result: providerResult.result,
    providerResult,
    executionHostId: options.executionHostId,
    directSshAuthority: options.directSshAuthority
  }
}

async function listWorktreeLineageForRuntime(
  settings: AppState['settings'],
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<{
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
}> {
  const target = getActiveRuntimeTarget(settings)
  type LineageListResponse = {
    lineage?: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
  }
  const normalizeLineageResponse = (value: Record<string, WorktreeLineage> | LineageListResponse) =>
    Object.hasOwn(value, 'lineage') || Object.hasOwn(value, 'workspaceLineage')
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
    }>(target, 'worktree.lineageList', undefined, {
      timeoutMs: 15_000,
      reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
    })
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

function projectLocalWorktreeLineageUpdate(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string,
  lineage: WorktreeLineage | null
): Record<string, Worktree[]> {
  let nextByRepo = worktreesByRepo
  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    let repoChanged = false
    const projected = worktrees.map((worktree) => {
      const current = worktree as WorktreeWithLineage
      const hadChild = current.childWorktreeIds?.includes(worktreeId) ?? false
      const isParent =
        lineage?.parentWorktreeId === worktree.id &&
        lineage.parentWorktreeInstanceId === worktree.instanceId
      let childWorktreeIds = current.childWorktreeIds
      if (hadChild) {
        childWorktreeIds = childWorktreeIds?.filter((id) => id !== worktreeId)
      }
      if (isParent && !childWorktreeIds?.includes(worktreeId)) {
        childWorktreeIds = [...(childWorktreeIds ?? []), worktreeId]
      }
      if (worktree.id === worktreeId) {
        repoChanged = true
        return {
          ...worktree,
          parentWorktreeId: lineage?.parentWorktreeId ?? null,
          lineage
        }
      }
      if (hadChild || isParent) {
        repoChanged = true
        return { ...worktree, childWorktreeIds }
      }
      return worktree
    })
    if (repoChanged) {
      if (nextByRepo === worktreesByRepo) {
        nextByRepo = { ...worktreesByRepo }
      }
      nextByRepo[repoId] = projected
    }
  }
  return nextByRepo
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
    const worktreesByRepo =
      result.target.kind === 'local'
        ? projectLocalWorktreeLineageUpdate(s.worktreesByRepo, worktreeId, result.lineage)
        : result.updatedRemoteWorktree
          ? replaceWorktreeInRepoLists(
              s.worktreesByRepo,
              withRepoHostOwnership(
                result.updatedRemoteWorktree,
                repoHostId(s, getRepoIdFromWorktreeId(result.updatedRemoteWorktree.id))
              )
            )
          : s.worktreesByRepo
    return {
      worktreeLineageById: next,
      workspaceLineageByChildKey: projectWorktreeLineageToWorkspaceLineage(
        worktreeId,
        result.lineage,
        s.workspaceLineageByChildKey
      ),
      worktreesByRepo,
      sortEpoch: s.sortEpoch + 1
    }
  })
}

function applyHostLineageRefresh(
  set: Parameters<StateCreator<AppState>>[0],
  hostId: ExecutionHostId,
  lineage: {
    worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
    workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
  }
): void {
  set((s) => {
    const worktreeLineageById = mergeLineageForHost(s, hostId, lineage.worktreeLineageById)
    const workspaceLineageByChildKey = mergeWorkspaceLineageForHost(
      s,
      hostId,
      lineage.workspaceLineageByChildKey
    )
    if (
      worktreeLineageById === s.worktreeLineageById &&
      workspaceLineageByChildKey === s.workspaceLineageByChildKey
    ) {
      return s
    }
    return { worktreeLineageById, workspaceLineageByChildKey }
  })
}

async function refreshWorktreeLineageForSettings(
  settings: AppState['settings'],
  set: Parameters<StateCreator<AppState>>[0],
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<void> {
  const lineage = await listWorktreeLineageForRuntime(settings, options)
  applyHostLineageRefresh(set, getSettingsFocusedExecutionHostId(settings), lineage)
}

async function refreshRemoteWorktreeLineageBestEffort(
  settings: AppState['settings'],
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
): Promise<void> {
  if (getActiveRuntimeTarget(settings).kind === 'local') {
    return
  }
  try {
    const lineage = await listWorktreeLineageForRuntime(settings, {
      reuseRecentCompatibilityFailure: true
    })
    applyHostLineageRefresh(set, getSettingsFocusedExecutionHostId(settings), lineage)
  } catch (err) {
    // Why: lineage is supplemental, so a remote timeout here must not discard a successful worktree refresh.
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
  lineage: Readonly<Record<string, WorktreeLineage>>
): Readonly<Record<string, WorktreeLineage>> {
  const next: Record<string, WorktreeLineage> = {}
  for (const [worktreeId, existing] of Object.entries(state.worktreeLineageById)) {
    if (getWorktreeHostId(state, worktreeId) !== hostId) {
      next[worktreeId] = existing
    }
  }
  for (const [worktreeId, incoming] of Object.entries(lineage)) {
    next[worktreeId] = incoming
  }
  return reuseEqualRecordMap(state.worktreeLineageById, next)
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
  lineage: Readonly<Record<string, WorkspaceLineage>>
): Readonly<Record<string, WorkspaceLineage>> {
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
  for (const [childKey, incoming] of Object.entries(lineage)) {
    next[childKey] = incoming
  }
  return reuseEqualRecordMap(state.workspaceLineageByChildKey, next)
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
  // Why: `worktree.set` parses in strip mode, so an older runtime drops the key
  // and applies the rest. Both gates key off presence, not value — a dropped
  // *clear* strands a stale link that the Issue row then hides.
  if (
    target.kind === 'environment' &&
    ('linkedWorkItem' in updates || 'linkedTaskSourceContext' in updates)
  ) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
      'Update the remote runtime to change this workspace’s linked issue'
    )
  }
  // task-source-context.v1 is a sound proxy for the Linear keys: #5322 added them
  // to the schema and is an ancestor of the commit introducing that capability.
  if (target.kind === 'environment' && 'linkedLinearIssue' in updates) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
      'Update the remote runtime to link Linear issues'
    )
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

// Why: an SSH per-workspace-env project's host is the runtime-owned SSH target; once that runtime is destroyed, remove the project or it lingers as a dead, never-connectable one.
async function purgeOrphanedRuntimeSshProjects(
  get: () => AppState,
  destroyedSshTargetIds: string[]
): Promise<void> {
  if (destroyedSshTargetIds.length === 0) {
    return
  }
  const destroyedTargetIds = new Set(destroyedSshTargetIds)
  const destroyedHostIds = new Set<ExecutionHostId>(
    destroyedSshTargetIds.map((id) => toSshExecutionHostId(id))
  )
  const orphanedSetupIds = get()
    .projectHostSetups.filter((setup) => destroyedHostIds.has(setup.hostId))
    .map((setup) => setup.id)
  const purgedRepoIds = new Set<string>()
  for (const setupId of orphanedSetupIds) {
    try {
      const result = await get().deleteProjectHostSetup({ setupId })
      if (result?.repo) {
        purgedRepoIds.add(result.repo.id)
      }
    } catch (error) {
      console.error('Failed to purge orphaned per-workspace-env project:', error)
    }
  }
  // A repo whose only host was the destroyed runtime can outlive its setup (pruned first by a projection refresh); remove it directly so no dead project lingers.
  const orphanedRepoIds = get()
    .repos.filter(
      (repo) => destroyedTargetIds.has(repo.connectionId ?? '') && !purgedRepoIds.has(repo.id)
    )
    .map((repo) => repo.id)
  for (const repoId of orphanedRepoIds) {
    try {
      await get().removeProject(repoId)
    } catch (error) {
      console.error('Failed to purge orphaned per-workspace-env repo:', error)
    }
  }
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

export function setDetachedHeadAutoDerivedDisplayNameForTests(
  worktreeId: string,
  displayName: string
): void {
  detachedHeadAutoDerivedDisplayNames.set(worktreeId, displayName)
}

export function getDetachedHeadAutoDerivedDisplayNameForTests(
  worktreeId: string
): string | undefined {
  return detachedHeadAutoDerivedDisplayNames.get(worktreeId)
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
    // Why: one branch pushes to one hosted-review head; stale provider links would win the target lookup after replacement.
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
  return Object.hasOwn(updates, key) ? (updates[key] ?? null) : (existingWorktree?.[key] ?? null)
}

function hasExplicitPushTargetClear(updates: Partial<WorktreeMeta>): boolean {
  return Object.hasOwn(updates, 'pushTarget') && updates.pushTarget === undefined
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
  // Why: remote runtime RPC is JSON-shaped and drops undefined, so null is the wire signal for clearing persisted pushTarget metadata.
  return { ...updates, pushTarget: null }
}

// Every worktree-id-keyed store map the rename path re-keys, so a new `*ByWorktree` map isn't silently missed.
// Tab-id/file-id-keyed maps are deliberately excluded: tabs and files keep their ids across a rename.
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
  'gitBranchLineTotalByWorktree',
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
  'defaultTerminalTabsAppliedByWorktreeId',
  'recentlyClosedTabKindsByWorktree'
] as const satisfies readonly (keyof AppState)[]

/**
 * Re-key every worktree-id-keyed map from `oldWorktreeId` to `newWorktreeId` after a folder
 * rename. Tab-id/file-id-keyed maps and active/renaming pointers stay put since tabs/files keep their ids.
 * Main-process counterpart: `Store.migrateWorktreeIdentity` in persistence.ts.
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
    fileSearchStateByWorktree: (searchState: AppState['fileSearchStateByWorktree'][string]) => ({
      ...searchState,
      resultOwner: searchState.resultOwner ? withNewWorktreeId(searchState.resultOwner) : null
    }),
    unifiedTabsByWorktree: (tabs: { worktreeId: string }[]) => tabs.map(withNewWorktreeId),
    groupsByWorktree: (groups: { worktreeId: string }[]) => groups.map(withNewWorktreeId)
  }
  for (const key of WORKTREE_ID_KEYED_MAP_KEYS) {
    renameKey(key, renameValueByKey[key] as ((value: unknown) => unknown) | undefined)
  }
  // Re-key on rename so a renamed worktree keeps its editor-undo + push/pull state.
  renameKey('recentlyClosedEditorTabsByWorktree', (files: { worktreeId: string }[]) =>
    files.map(withNewWorktreeId)
  )
  // Why: terminal reopen snapshots hold absolute startupCwd paths under the old folder; remap or Cmd+Shift+T respawns into a directory that no longer exists after the rename.
  const oldWorktreePath = splitWorktreeIdForFilesystem(oldWorktreeId)?.worktreePath
  const newWorktreePath = splitWorktreeIdForFilesystem(newWorktreeId)?.worktreePath
  renameKey('recentlyClosedTerminalTabsByWorktree', (snapshots: ClosedTerminalTabSnapshot[]) =>
    oldWorktreePath && newWorktreePath
      ? remapClosedTerminalTabSnapshotCwds(snapshots, oldWorktreePath, newWorktreePath)
      : snapshots
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
  // Why: every authoritative and explicit purge converges here, so a deleted path can't inherit stale UI state.
  forgetHugeRepoWarningDismissalsForWorktrees(worktreeIdSet)

  // Collect every tab id (and removed file id) we are about to orphan.
  const doomedTabIds = new Set<string>()
  // Why: some terminal/agent maps are keyed by ptyId, not tabId; collect durable wake hints too since slept panes have left the live index.
  const doomedPtyIds = new Set<string>()
  const addDoomedPtyId = (ptyId: string | null | undefined): void => {
    if (!ptyId) {
      return
    }
    doomedPtyIds.add(ptyId)
  }
  const addDoomedTabPtyIds = (tabId: string, tabPtyId: string | null | undefined): void => {
    for (const ptyId of s.ptyIdsByTabId?.[tabId] ?? []) {
      addDoomedPtyId(ptyId)
    }
    addDoomedPtyId(tabPtyId)
    addDoomedPtyId(s.lastKnownRelayPtyIdByTabId?.[tabId])
    for (const ptyId of Object.values(s.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {})) {
      addDoomedPtyId(ptyId)
    }
  }
  const doomedBrowserWorkspaceIds = new Set<string>()
  const doomedPageIds = new Set<string>()
  const removedFileIds = new Set<string>()
  for (const id of worktreeIdSet) {
    for (const tab of s.tabsByWorktree[id] ?? []) {
      doomedTabIds.add(tab.id)
      // Null-tolerant like the omit* helpers below: some callers pass partial state omitting this slice (production store always inits to {}).
      addDoomedTabPtyIds(tab.id, tab.ptyId)
      // Why: a removed worktree's panes are gone, so drop their hibernation output epochs from the module-level map (a future pane mints a fresh leafId at epoch 0).
      forgetAgentHibernationTabOutput(tab.id)
    }
    for (const workspace of s.browserTabsByWorktree[id] ?? []) {
      doomedBrowserWorkspaceIds.add(workspace.id)
    }
    // Why: drop the auto-derived detached-HEAD display name so the module-level map doesn't retain removed worktrees for the session.
    detachedHeadAutoDerivedDisplayNames.delete(id)
  }
  // Why: same rationale for doomed tabs' foreground last-seen timestamps and agent-startup delivery guards — retired tab ids never recur.
  forgetForegroundTerminalTabs(doomedTabIds)
  forgetAgentStartupDeliveriesForTabs(doomedTabIds)
  // Why: pane-authority aliases outlive the store maps they route to, so a purged
  // tab would leave a permanent entry pointing at a pane that no longer exists.
  forgetAgentPaneAuthorityAliasesByTabIds(doomedTabIds)
  // Why: per-page browser maps are keyed by page id, so collect every page of a doomed workspace to evict here (the authoritative-scan reconcile skips closeBrowserTab's cleanup).
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
  const survivingTabIds = new Set(
    Object.entries(s.tabsByWorktree)
      .filter(([worktreeId]) => !worktreeIdSet.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  )
  const omitRetiredDirectSshLedgerByTabId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const tabId of doomedTabIds) {
      if (!survivingTabIds.has(tabId) && tabId in out) {
        delete out[tabId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByPtyId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const ptyId of doomedPtyIds) {
      if (ptyId in out) {
        delete out[ptyId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  // Pane-scoped maps are keyed `${tabId}:${leafId}`; tabId never contains ":", so the prefix before the first ":" is the owning tab.
  const omitByPaneKeyTabPrefix = <T>(obj: Record<string, T>): Record<string, T> => {
    // Null-tolerant like omitByTabId: some worktree-isolation callers omit these slices (production store always inits to {}).
    if (!obj) {
      return obj
    }
    let changed = false
    const out = { ...obj }
    for (const paneKey of Object.keys(obj)) {
      const sep = paneKey.indexOf(':')
      if (sep > 0 && doomedTabIds.has(paneKey.slice(0, sep))) {
        delete out[paneKey]
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
  const nextAgentStatusByPaneKey = omitByPaneKeyTabPrefix(s.agentStatusByPaneKey)

  return {
    // Worktree-scoped terminal/tab state
    worktreeLineageById: omitByWorktree(s.worktreeLineageById),
    workspaceLineageByChildKey: omitWorkspaceLineageByWorktree(s.workspaceLineageByChildKey),
    tabsByWorktree: omitByWorktree(s.tabsByWorktree),
    terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
    ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
    runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
    automaticAgentResumeClaimsByTabId: omitByTabId(s.automaticAgentResumeClaimsByTabId),
    nativeChatLaunchPromptByTabId: omitByTabId(s.nativeChatLaunchPromptByTabId),
    nativeChatLaunchDraftByTabId: omitByTabId(s.nativeChatLaunchDraftByTabId),
    // Why: bulk/hydration purge runs no terminal teardown, so it must drop the per-tab pane-expand flags itself.
    expandedPaneByTabId: omitByTabId(s.expandedPaneByTabId),
    canExpandPaneByTabId: omitByTabId(s.canExpandPaneByTabId),
    // Why: these per-tab/per-pty terminal+agent maps evict on the single removeWorktree teardown path; the bulk reconcile / remove-project / hydration-stale paths run no teardown, so without these each strands an entry per tab/pane of externally-removed worktrees.
    lastKnownRelayPtyIdByTabId: omitByTabId(s.lastKnownRelayPtyIdByTabId),
    // Why: liveness-authoritative reconnect maps (orphan sweep reads them); drop purged tabs' entries here too so a re-materialized id can't inherit phantom liveness.
    pendingReconnectPtyIdByTabId: omitByTabId(s.pendingReconnectPtyIdByTabId),
    deferredSshSessionIdsByTabId: omitByTabId(s.deferredSshSessionIdsByTabId),
    pendingInitialCwdByTabId: omitByTabId(s.pendingInitialCwdByTabId),
    pendingIssueCommandSplitByTabId: omitByTabId(s.pendingIssueCommandSplitByTabId),
    pendingSetupSplitByTabId: omitByTabId(s.pendingSetupSplitByTabId),
    pendingStartupByTabId: omitByTabId(s.pendingStartupByTabId),
    directSshPaneRetryByTabId: omitRetiredDirectSshLedgerByTabId(s.directSshPaneRetryByTabId),
    directSshLivePtyBindingByTabId: omitRetiredDirectSshLedgerByTabId(
      s.directSshLivePtyBindingByTabId
    ),
    directSshPaneRetryHistoryByTabId: omitRetiredDirectSshLedgerByTabId(
      s.directSshPaneRetryHistoryByTabId
    ),
    codexRestartNoticeByPtyId: omitByPtyId(s.codexRestartNoticeByPtyId),
    migrationUnsupportedByPtyId: omitByPtyId(s.migrationUnsupportedByPtyId),
    suppressedPtyExitIds: omitByPtyId(s.suppressedPtyExitIds),
    pendingCodexPaneRestartIds: omitByPtyId(s.pendingCodexPaneRestartIds),
    // Why: these agent-status/unread/input maps clear only on the single removeWorktree teardown path; the bulk reconcile / remove-project / hydration-stale paths run no teardown, so without this they orphan an entry per agent pane (plus a phantom unread badge).
    // retainedAgentsByPaneKey and runtimeAgentOrchestrationByPaneKey are omitted here — both self-heal (pruneRetainedAgents on worktreesByRepo change; runtime map replaced wholesale each sync).
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    ...(nextAgentStatusByPaneKey !== s.agentStatusByPaneKey
      ? { agentStatusEpoch: s.agentStatusEpoch + 1 }
      : {}),
    agentLaunchConfigByPaneKey: omitByPaneKeyTabPrefix(s.agentLaunchConfigByPaneKey),
    acknowledgedAgentsByPaneKey: omitByPaneKeyTabPrefix(s.acknowledgedAgentsByPaneKey),
    paneForegroundAgentByPaneKey: omitByPaneKeyTabPrefix(s.paneForegroundAgentByPaneKey),
    sleepingAgentSessionsByPaneKey: omitByPaneKeyTabPrefix(s.sleepingAgentSessionsByPaneKey),
    unreadTerminalTabs: omitByTabId(s.unreadTerminalTabs),
    unreadTerminalPanes: omitByPaneKeyTabPrefix(s.unreadTerminalPanes),
    unreadAgentCompletionPanes: omitByPaneKeyTabPrefix(s.unreadAgentCompletionPanes),
    lastTerminalInputAtByPaneKey: omitByPaneKeyTabPrefix(s.lastTerminalInputAtByPaneKey),
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
    // Why: keyed by page/workspace id, only cleaned by closeBrowserTab on the single-removal path; the bulk reconcile missed them, orphaning an entry per page of externally-removed worktrees.
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
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal paths (upstream-status entry).
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
    // Why: keyed by worktreeId; without this it leaks a huge-status marker per removed worktree.
    gitStatusHugeByWorktree: omitByWorktree(s.gitStatusHugeByWorktree),
    showDotfilesByWorktree: omitByWorktree(s.showDotfilesByWorktree),
    expandedDirs: omitByWorktree(s.expandedDirs),
    // Per-file editor state for removed files
    editorDrafts: omitByFileId(s.editorDrafts),
    markdownViewMode: omitByFileId(s.markdownViewMode),
    markdownFrontmatterVisible: omitByFileId(s.markdownFrontmatterVisible),
    // Why: keyed by fileId; the bulk reconcile path previously kept these, leaking a cursor-line / view-mode entry per removed file.
    editorCursorLine: omitByFileId(s.editorCursorLine),
    editorViewMode: omitByFileId(s.editorViewMode),
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal paths (editor-undo / Cmd+Shift+T snapshots).
    recentlyClosedEditorTabsByWorktree: omitByWorktree(s.recentlyClosedEditorTabsByWorktree),
    recentlyClosedTerminalTabsByWorktree: omitByWorktree(s.recentlyClosedTerminalTabsByWorktree),
    recentlyClosedTabKindsByWorktree: omitByWorktree(s.recentlyClosedTabKindsByWorktree),
    // Top-level actives
    openFiles: nextOpenFiles,
    everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
    lastVisitedAtByWorktreeId: omitByWorktree(s.lastVisitedAtByWorktreeId),
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal paths (write-once default-terminal guard).
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
    })(),
    activeFileId: activeFileCleared ? null : s.activeFileId,
    activeBrowserTabId: removedActive ? null : s.activeBrowserTabId,
    activeTabId: activeTabCleared ? null : s.activeTabId,
    activeTabType: removedActive || activeFileCleared ? 'terminal' : s.activeTabType
  }
}

function directSshAuthorityIsComplete(
  authority: DirectSshAuthority,
  expectedTargetId: string
): boolean {
  if (
    authority.targetId !== expectedTargetId ||
    typeof authority.providerEpoch !== 'string' ||
    authority.providerEpoch.length === 0 ||
    !Number.isSafeInteger(authority.connectionGeneration) ||
    authority.connectionGeneration < 0
  ) {
    return false
  }
  return true
}

function getCurrentDirectSshAuthority(
  state: Pick<AppState, 'sshConnectionStates'>,
  hostId: ExecutionHostId
): DirectSshAuthority | null {
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind !== 'ssh') {
    return null
  }
  const connection = state.sshConnectionStates?.get(parsedHost.targetId)
  if (connection?.status !== 'connected') {
    return null
  }
  const authority = {
    targetId: parsedHost.targetId,
    providerEpoch: connection.providerEpoch,
    connectionGeneration: connection.connectionGeneration
  } as DirectSshAuthority
  if (!directSshAuthorityIsComplete(authority, parsedHost.targetId)) {
    return null
  }
  return {
    ...authority
  }
}

function directSshAuthoritiesEqual(
  left: DirectSshAuthority | null | undefined,
  right: DirectSshAuthority | null | undefined
): boolean {
  if (!left || !right) {
    return false
  }
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}

function isCurrentDetectedWorktreeRefresh(
  state: Pick<AppState, 'sshConnectionStates'>,
  refresh: AdmittedDetectedWorktreeRefresh
): boolean {
  if (refresh.directSshAuthority) {
    return directSshAuthoritiesEqual(
      getCurrentDirectSshAuthority(state, refresh.executionHostId),
      refresh.directSshAuthority
    )
  }
  if (refresh.runtimeAuthority) {
    return (
      getEnvironmentSshStateGeneration(refresh.runtimeAuthority.environmentId) ===
        refresh.runtimeAuthority.connectionGeneration &&
      getRuntimeEnvironmentConnectionGeneration(refresh.runtimeAuthority.environmentId) ===
        refresh.runtimeAuthority.runtimeConnectionGeneration
    )
  }
  return true
}

function staleDetectedWorktreeProviderResult(
  refresh: AdmittedDetectedWorktreeRefresh
): HostQualifiedDetectedWorktreeResult | undefined {
  return refresh.providerResult
    ? {
        providerRequestId: refresh.providerResult.providerRequestId,
        executionHostId: refresh.executionHostId,
        status: 'stale'
      }
    : undefined
}

function preserveConcurrentManualOrder<T extends Worktree>(
  incoming: readonly T[],
  requestStarted: readonly Worktree[] | undefined,
  current: readonly Worktree[] | undefined,
  matchesRefreshHost: (worktree: Worktree) => boolean
): T[] {
  if (!requestStarted || !current) {
    return [...incoming]
  }
  const startedById = new Map(
    requestStarted.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  const currentById = new Map(
    current.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  return incoming.map((worktree) => {
    const started = startedById.get(worktree.id)
    const latest = currentById.get(worktree.id)
    if (!started || !latest || started.manualOrder === latest.manualOrder) {
      return worktree
    }
    // Why: a refresh response may predate a completed drag; the renderer's optimistic rank is newer.
    return { ...worktree, manualOrder: latest.manualOrder }
  })
}

type FencedWorktreeMergeArgs = {
  repoId: string
  hostId: ExecutionHostId
  ownerWasMissingAtStart: boolean
  missingDirectSshOwnerReposSnapshot?: AppState['repos']
  requestStartedWorktrees: readonly Worktree[] | undefined
  setup?: ProjectHostSetup
  refresh: AdmittedDetectedWorktreeRefresh
  purgeRemovedWorktrees?: boolean
}

function mergeFetchedWorktrees(
  set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  args: FencedWorktreeMergeArgs
): boolean {
  let admitted = false
  let authoritativelyRemovedIds: readonly string[] = []
  let authoritativelySeenIds: readonly string[] = []
  set((s) => {
    if (
      !isCurrentDetectedWorktreeRefresh(s, args.refresh) ||
      !repoHasExactlyOneExecutionHostOwner(
        s,
        args.repoId,
        args.hostId,
        args.ownerWasMissingAtStart &&
          (!args.refresh.directSshAuthority || s.repos === args.missingDirectSshOwnerReposSnapshot)
      )
    ) {
      return s
    }
    admitted = true
    const matchOptions = worktreeHostMatchOptions(s, args.repoId, args.hostId)
    const currentWorktrees = s.worktreesByRepo[args.repoId]
    const refreshResult = {
      ...args.refresh.result,
      worktrees: preserveConcurrentManualOrder(
        args.refresh.result.worktrees,
        args.requestStartedWorktrees,
        currentWorktrees,
        (worktree) => worktreeMatchesHost(worktree, args.hostId, matchOptions)
      )
    }
    let incoming = toVisibleWorktrees(refreshResult, args.hostId, args.setup)
    incoming = routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: args.requestStartedWorktrees,
      current: s.worktreesByRepo[args.repoId],
      incoming,
      matchesRefreshHost: (worktree) => worktreeMatchesHost(worktree, args.hostId, matchOptions),
      hasBranchScopedReviewContext: hasBranchScopedHostedReviewContext,
      updateWorktreeGitIdentity: s.updateWorktreeGitIdentity
    })
    const worktrees = sanitizeHostedReviewLinksForBranchClears(
      incoming,
      s.worktreesByRepo[args.repoId]
    )
    const currentForHost = (s.worktreesByRepo[args.repoId] ?? []).filter((worktree) =>
      worktreeMatchesHost(worktree, args.hostId, matchOptions)
    )
    const mergedDetected = mergeDetectedWorktreesForHost(
      s.detectedWorktreesByRepo[args.repoId],
      refreshResult,
      args.hostId,
      args.setup,
      matchOptions
    )
    if (!args.refresh.result.authoritative && worktrees.length === 0 && currentForHost.length > 0) {
      return areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[args.repoId], mergedDetected)
        ? s
        : {
            detectedWorktreesByRepo: {
              ...s.detectedWorktreesByRepo,
              [args.repoId]: mergedDetected
            }
          }
    }
    const mergedWorktrees = mergeWorktreesForHost(
      s.worktreesByRepo[args.repoId],
      worktrees,
      args.hostId,
      matchOptions
    )
    const removedIds =
      args.purgeRemovedWorktrees === false
        ? []
        : getRemovedWorktreeIdsAfterAuthoritativeScan(
            s,
            args.repoId,
            args.refresh.result,
            args.hostId
          )
    authoritativelyRemovedIds = removedIds
    if (args.refresh.result.authoritative) {
      authoritativelySeenIds = args.refresh.result.worktrees.map((worktree) => worktree.id)
    }
    const worktreesChanged = !areWorktreesEqual(s.worktreesByRepo[args.repoId], mergedWorktrees)
    const detectedChanged = !areDetectedWorktreeResultsEqual(
      s.detectedWorktreesByRepo[args.repoId],
      mergedDetected
    )
    if (!worktreesChanged && !detectedChanged && removedIds.length === 0) {
      return s
    }
    return {
      ...(worktreesChanged
        ? {
            worktreesByRepo: {
              ...s.worktreesByRepo,
              [args.repoId]: mergedWorktrees
            },
            sortEpoch: s.sortEpoch + 1
          }
        : {}),
      ...(detectedChanged
        ? {
            detectedWorktreesByRepo: {
              ...s.detectedWorktreesByRepo,
              [args.repoId]: mergedDetected
            }
          }
        : {}),
      ...(removedIds.length > 0 ? buildWorktreePurgeState(s, removedIds) : {})
    }
  })
  if (admitted) {
    // Why: applied outside the updater so a repeated updater call cannot double-apply the removal memory.
    forgetAuthoritativelyRemovedWorktrees(args.hostId, authoritativelySeenIds)
    rememberAuthoritativelyRemovedWorktrees(args.hostId, authoritativelyRemovedIds)
    forgetPersistedWorktreeMetaForRemovals(args.repoId, args.hostId, authoritativelyRemovedIds)
  }
  return admitted
}

// Why: main retires the persisted SSH metadata a scan proved gone, but that IPC is async and the next fallback
// read can already be in flight, so this session memory covers the window until the delete lands. It is not the
// durable half: reloads start empty and rely on the metadata itself being gone.
const AUTHORITATIVE_REMOVAL_MEMORY_LIMIT = 512
const authoritativelyRemovedWorktreeIdsByHost = new Map<ExecutionHostId, Set<string>>()

function rememberAuthoritativelyRemovedWorktrees(
  hostId: ExecutionHostId,
  worktreeIds: readonly string[]
): void {
  if (worktreeIds.length === 0) {
    return
  }
  const removed = authoritativelyRemovedWorktreeIdsByHost.get(hostId) ?? new Set<string>()
  for (const worktreeId of worktreeIds) {
    // Why: re-insert so a re-removed id moves to the back of the insertion order the cap evicts from.
    removed.delete(worktreeId)
    removed.add(worktreeId)
  }
  for (const oldest of removed) {
    if (removed.size <= AUTHORITATIVE_REMOVAL_MEMORY_LIMIT) {
      break
    }
    removed.delete(oldest)
  }
  authoritativelyRemovedWorktreeIdsByHost.set(hostId, removed)
}

// Why: a remote path can be recreated, so a scan that reports it again retracts the deletion verdict.
function forgetAuthoritativelyRemovedWorktrees(
  hostId: ExecutionHostId,
  worktreeIds: Iterable<string>
): void {
  const removed = authoritativelyRemovedWorktreeIdsByHost.get(hostId)
  if (!removed) {
    return
  }
  for (const worktreeId of worktreeIds) {
    removed.delete(worktreeId)
  }
  if (removed.size === 0) {
    authoritativelyRemovedWorktreeIdsByHost.delete(hostId)
  }
}

/** Test-only: module-level removal memory would otherwise leak across cases in one file. */
export function resetAuthoritativelyRemovedWorktreeMemoryForTests(): void {
  authoritativelyRemovedWorktreeIdsByHost.clear()
}

// Why: SSH WorktreeMeta is exempt from gcStaleWorktreeMeta (persistence.ts:407,415) and outlives the remote
// worktree, so a scan-proven removal must retire the metadata itself — otherwise the next launch's fallback
// re-lists the deleted row before the host connects, and the in-memory suppression above is already gone.
function forgetPersistedWorktreeMetaForRemovals(
  repoId: string,
  hostId: ExecutionHostId,
  worktreeIds: readonly string[]
): void {
  const parsedHost = parseExecutionHostId(hostId)
  if (worktreeIds.length === 0 || parsedHost?.kind !== 'ssh') {
    return
  }
  const forget = window.api.worktrees.forgetRemovedForExecutionHost
  if (typeof forget !== 'function') {
    return
  }
  void forget({ repoId, executionHostId: parsedHost.id, worktreeIds: [...worktreeIds] }).catch(
    (err) => {
      console.warn(`Failed to forget metadata for removed worktrees in repo ${repoId}:`, err)
    }
  )
}

function appendMissingWorktreesForHost<
  T extends { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
>(
  current: readonly T[] | undefined,
  incoming: readonly T[],
  hostId: ExecutionHostId,
  options: WorktreeHostMatchOptions
): T[] {
  const existing = current ?? []
  const existingHostIds = new Set(
    existing
      .filter((worktree) => worktreeMatchesHost(worktree, hostId, options))
      .map(({ id }) => id)
  )
  const missing = incoming.filter((worktree) => !existingHostIds.has(worktree.id))
  if (missing.length === 0) {
    return [...existing]
  }
  // Why: land inside the host's block like mergeWorktreesForHost does, else these rows sit past sibling hosts and visibly jump once the authoritative scan splices them back.
  const lastHostIndex = existing.findLastIndex((worktree) =>
    worktreeMatchesHost(worktree, hostId, options)
  )
  if (lastHostIndex === -1) {
    return [...existing, ...missing]
  }
  return [...existing.slice(0, lastHostIndex + 1), ...missing, ...existing.slice(lastHostIndex + 1)]
}

function isAdmittedKnownSshWorktreeResult(
  result: HostQualifiedKnownWorktreeResult,
  repoId: string,
  executionHostId: SshExecutionHostId
): result is Extract<HostQualifiedKnownWorktreeResult, { status: 'complete' }> {
  return (
    result.status === 'complete' &&
    result.repoId === repoId &&
    result.executionHostId === executionHostId &&
    isDetectedWorktreeListResult(result.result) &&
    result.result.repoId === repoId &&
    result.result.authoritative === false
  )
}

const inflightKnownSshWorktreeFetches = new Map<
  string,
  Promise<DetectedWorktreeListResult | null>
>()

// Why: the authoritative path dedupes through listDetectedWorktreesForRepoCoalesced; without a matching guard
// the four refresh triggers can each issue this IPC and its merge for the same repo/host.
async function fetchKnownSshWorktreesForRepo(
  set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  repoId: string,
  executionHostId: SshExecutionHostId
): Promise<DetectedWorktreeListResult | null> {
  const coalesceKey = `${repoId}\0${executionHostId}`
  const inflight = inflightKnownSshWorktreeFetches.get(coalesceKey)
  if (inflight) {
    return await inflight
  }
  const request = runKnownSshWorktreeFetch(set, repoId, executionHostId).finally(() => {
    inflightKnownSshWorktreeFetches.delete(coalesceKey)
  })
  inflightKnownSshWorktreeFetches.set(coalesceKey, request)
  return await request
}

async function runKnownSshWorktreeFetch(
  set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  repoId: string,
  executionHostId: SshExecutionHostId
): Promise<DetectedWorktreeListResult | null> {
  // Why: reads the local store only, so a runtime-hub session (whose repo ids live on the hub) always gets 'rejected' and keeps the pre-existing no-op.
  const listKnown = window.api.worktrees.listKnownForExecutionHost
  if (typeof listKnown !== 'function') {
    return null
  }
  const result = await listKnown({ repoId, executionHostId })
  if (!isAdmittedKnownSshWorktreeResult(result, repoId, executionHostId)) {
    return null
  }
  // Why: persisted SSH metadata outlives the remote worktree, so drop rows a completed scan already proved gone.
  const suppressedIds = authoritativelyRemovedWorktreeIdsByHost.get(executionHostId)
  const known =
    suppressedIds && suppressedIds.size > 0
      ? {
          ...result.result,
          worktrees: result.result.worktrees.filter((worktree) => !suppressedIds.has(worktree.id))
        }
      : result.result
  let admitted = false
  set((state) => {
    // Why: the provider can connect during the await; authoritative rows already replaced this host, so appending stale metadata would resurrect purged worktrees.
    if (
      getCurrentDirectSshAuthority(state, executionHostId) ||
      !repoHasExactlyOneExecutionHostOwner(state, repoId, executionHostId, false)
    ) {
      return state
    }
    admitted = true
    const setup = getProjectHostSetupForRepoHost(state, repoId, executionHostId)
    const matchOptions = worktreeHostMatchOptions(state, repoId, executionHostId)
    const incomingDetected = known.worktrees.map((worktree) =>
      withRepoHostOwnership(worktree, executionHostId, setup)
    )
    const priorDetected = state.detectedWorktreesByRepo[repoId]
    // Why: only the rows are ours to merge. This entry is keyed by repo alone, so adopting the fallback's
    // authoritative/source would demote a sibling host's completed scan and blank every authoritative-gated surface.
    const detected = {
      ...(priorDetected ?? known),
      worktrees: appendMissingWorktreesForHost(
        priorDetected?.worktrees,
        incomingDetected,
        executionHostId,
        matchOptions
      )
    }
    const worktrees = appendMissingWorktreesForHost(
      state.worktreesByRepo[repoId],
      toVisibleWorktrees(known, executionHostId, setup),
      executionHostId,
      matchOptions
    )
    const worktreesChanged = !areWorktreesEqual(state.worktreesByRepo[repoId], worktrees)
    const detectedChanged = !areDetectedWorktreeResultsEqual(
      state.detectedWorktreesByRepo[repoId],
      detected
    )
    if (!worktreesChanged && !detectedChanged) {
      return state
    }
    return {
      ...(worktreesChanged
        ? {
            worktreesByRepo: { ...state.worktreesByRepo, [repoId]: worktrees },
            sortEpoch: state.sortEpoch + 1
          }
        : {}),
      ...(detectedChanged
        ? { detectedWorktreesByRepo: { ...state.detectedWorktreesByRepo, [repoId]: detected } }
        : {})
    }
  })
  return admitted ? known : null
}

export type DirectSshDetectedWorktreeRefresh = {
  waiterLeaseId: DetectedWorktreeRefreshLease['waiterLeaseId']
  providerRequestId: ProviderRequestId
  result: Promise<HostQualifiedDetectedWorktreeResult>
  release: DetectedWorktreeRefreshLease['release']
  merge(result: HostQualifiedDetectedWorktreeResult): HostQualifiedDetectedWorktreeResult
}

export function acquireDirectSshDetectedWorktreeRefresh(
  store: Pick<StoreApi<AppState>, 'getState' | 'setState'>,
  request: {
    repoId: string
    executionHostId: SshExecutionHostId
    authority: DirectSshAuthority
    requireAuthoritative?: boolean
  }
): DirectSshDetectedWorktreeRefresh {
  const requestStartedState = store.getState()
  const requestStartedWorktrees = requestStartedState.worktreesByRepo[request.repoId]
  const ownerWasMissingAtStart = !requestStartedState.repos.some(
    (repo) => repo.id === request.repoId
  )
  const setup = getProjectHostSetupForRepoHost(
    requestStartedState,
    request.repoId,
    request.executionHostId
  )
  const settings = settingsForRepoOwner(
    requestStartedState,
    request.repoId,
    request.executionHostId
  )
  const options: DetectedWorktreeRefreshOptions = {
    executionHostId: request.executionHostId,
    directSshAuthority: request.authority,
    requireAuthoritative: request.requireAuthoritative
  }
  const lease = acquireDetectedWorktreeRefreshLeaseForRepo(settings, request.repoId, options)
  let mergedResult: HostQualifiedDetectedWorktreeResult | undefined

  return {
    waiterLeaseId: lease.waiterLeaseId,
    providerRequestId: lease.providerRequestId,
    result: lease.result,
    release: lease.release,
    merge: (providerResult) => {
      if (mergedResult) {
        return mergedResult
      }
      if (
        !qualifiedProviderResultIsAdmitted(
          providerResult,
          lease.providerRequestId,
          request.repoId,
          options
        )
      ) {
        mergedResult = normalizeNotAdmittedProviderResult(
          providerResult,
          lease.providerRequestId,
          request.executionHostId
        )
        return mergedResult
      }
      if (request.requireAuthoritative && providerResult.status !== 'complete') {
        mergedResult = providerResult
        return mergedResult
      }
      const refresh: AdmittedDetectedWorktreeRefresh = {
        status: 'admitted',
        result: providerResult.result,
        providerResult,
        executionHostId: request.executionHostId,
        directSshAuthority: request.authority
      }
      const admitted = mergeFetchedWorktrees(
        store.setState as Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
        {
          repoId: request.repoId,
          hostId: request.executionHostId,
          ownerWasMissingAtStart,
          requestStartedWorktrees,
          setup,
          refresh
        }
      )
      mergedResult = admitted
        ? providerResult
        : (staleDetectedWorktreeProviderResult(refresh) ?? providerResult)
      return mergedResult
    }
  }
}

export const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  detectedWorktreesByRepo: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  activeWorktreeId: null,
  activeWorkspaceKey: null,
  activeWorkspaceExecutionHostId: null,
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
  startupWorktreeRefreshCompleted: false,

  fetchDetectedWorktrees: async (repoId) => {
    try {
      const ownerState = get()
      const hostId = repoHostId(ownerState, repoId)
      const ownerWasMissingAtStart = !ownerState.repos.some((repo) => repo.id === repoId)
      const setup = getProjectHostSetupForRepoHost(ownerState, repoId, hostId)
      const repoOwner = findRepoForHost(ownerState.repos, repoId, {
        hostId,
        settings: ownerState.settings
      })
      const parsedHost = parseExecutionHostId(hostId)
      const directSshAuthority =
        parsedHost?.kind === 'ssh'
          ? (getCurrentDirectSshAuthority(ownerState, hostId) ?? undefined)
          : undefined
      if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
        // Why: this function's contract is detected-only. The fallback runs for its store side effect, but
        // callers keep seeing null as they did before the metadata path existed.
        await fetchKnownSshWorktreesForRepo(set, repoId, parsedHost.id)
        return null
      }
      const refresh = await listDetectedWorktreesForRepoCoalesced(
        settingsForRepoOwner(ownerState, repoId, hostId),
        repoId,
        {
          executionHostId: hostId,
          directSshAuthority,
          connectionId: repoOwner?.connectionId,
          knownWorktreeIds: getKnownWorktreeIdsForPurge(ownerState, repoId, hostId)
        }
      )
      if (refresh.status !== 'admitted') {
        return null
      }
      let admitted = false
      set((s) => {
        if (
          !isCurrentDetectedWorktreeRefresh(s, refresh) ||
          !repoHasExactlyOneExecutionHostOwner(
            s,
            repoId,
            hostId,
            ownerWasMissingAtStart && !refresh.directSshAuthority
          )
        ) {
          return s
        }
        admitted = true
        // Why: detected-only refreshes can overlap host-scoped visible refreshes; merge detected state so SSH/runtime rows aren't clobbered.
        const mergedDetected = mergeDetectedWorktreesForHost(
          s.detectedWorktreesByRepo[repoId],
          refresh.result,
          hostId,
          setup,
          worktreeHostMatchOptions(s, repoId, hostId)
        )
        return areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[repoId], mergedDetected)
          ? s
          : {
              detectedWorktreesByRepo: {
                ...s.detectedWorktreesByRepo,
                [repoId]: mergedDetected
              }
            }
      })
      return admitted ? refresh.result : null
    } catch (err) {
      if (notifyRuntimeScopeForbiddenIfNeeded(err)) {
        return null
      }
      console.error(`Failed to fetch detected worktrees for repo ${repoId}:`, err)
      return null
    }
  },

  fetchWorktrees: (async (
    repoId: string,
    options?: WorktreeFetchOptions | DirectSshWorktreeFetchOptions
  ) => {
    const directCallerAuthority =
      options && 'directSshAuthority' in options ? options.directSshAuthority : undefined
    try {
      const ownerState = get()
      const requestStartedWorktrees = ownerState.worktreesByRepo[repoId]
      const repoOwners = ownerState.repos.filter((repo) => repo.id === repoId)
      const ownerWasMissingAtStart = repoOwners.length === 0
      const hasLocalOwner = repoOwners.some(
        (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
      // Why: a local event may share its repo id with the focused runtime; prefer
      // the local owner without redirecting runtime/SSH-only repos.
      const useLocalOwner =
        options?.forceLocalOwner === true && (hasLocalOwner || repoOwners.length === 0)
      const hostId = useLocalOwner
        ? LOCAL_EXECUTION_HOST_ID
        : repoHostId(ownerState, repoId, options?.executionHostId)
      const setup = getProjectHostSetupForRepoHost(ownerState, repoId, hostId)
      const repoOwner = findRepoForHost(ownerState.repos, repoId, {
        hostId,
        settings: ownerState.settings
      })
      const ownerSettings = settingsForRepoOwner(
        ownerState,
        repoId,
        hostId,
        ownerWasMissingAtStart && (useLocalOwner || options?.executionHostId !== undefined)
      )
      const settings =
        useLocalOwner && ownerSettings?.activeRuntimeEnvironmentId
          ? { ...ownerSettings, activeRuntimeEnvironmentId: null }
          : ownerSettings
      const parsedHost = parseExecutionHostId(hostId)
      const directSshAuthority =
        parsedHost?.kind === 'ssh'
          ? (directCallerAuthority ?? getCurrentDirectSshAuthority(ownerState, hostId) ?? undefined)
          : undefined
      if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
        // Why: requireAuthoritative callers asked for authoritative-or-nothing, so writing non-authoritative
        // rows as a side effect before returning false would silently weaken that contract.
        if (!options?.requireAuthoritative) {
          await fetchKnownSshWorktreesForRepo(set, repoId, parsedHost.id)
        }
        return false
      }
      const refresh = await listDetectedWorktreesForRepoCoalesced(settings, repoId, {
        executionHostId: hostId,
        requireAuthoritative: options?.requireAuthoritative,
        directSshAuthority,
        connectionId: repoOwner?.connectionId,
        knownWorktreeIds: getKnownWorktreeIdsForPurge(ownerState, repoId, hostId)
      })
      if (refresh.status !== 'admitted') {
        return directCallerAuthority ? refresh.providerResult : false
      }
      if (options?.requireAuthoritative && !refresh.result.authoritative) {
        return directCallerAuthority ? refresh.providerResult : false
      }
      const admitted = mergeFetchedWorktrees(set, {
        repoId,
        hostId,
        ownerWasMissingAtStart,
        missingDirectSshOwnerReposSnapshot:
          ownerWasMissingAtStart && options?.executionHostId === hostId
            ? ownerState.repos
            : undefined,
        requestStartedWorktrees,
        setup,
        refresh
      })
      if (!admitted) {
        return directCallerAuthority
          ? (staleDetectedWorktreeProviderResult(refresh) ?? false)
          : false
      }
      // Direct SSH lineage requires its own qualified authority result.
      // Bulk runtime callers apply one final host-wide snapshot after all repo merges.
      if (!directSshAuthority && !options?.suppressRemoteLineageRefresh) {
        await refreshRemoteWorktreeLineageBestEffort(settings, set)
      }
      return directCallerAuthority ? refresh.providerResult! : refresh.result.authoritative
    } catch (err) {
      if (notifyRuntimeScopeForbiddenIfNeeded(err)) {
        return false
      }
      console.error(`Failed to fetch worktrees for repo ${repoId}:`, err)
      return false
    }
  }) as WorktreeSlice['fetchWorktrees'],

  fetchAllWorktrees: async (options) => {
    const { repos } = get()

    // Why: after the one-shot hydration purge, later calls only refresh cached lists — no IPC double-probe for the per-repo success signal.
    if (get().hasHydratedWorktreePurge) {
      await mapReposForWorktreeRefresh(repos, async (r) => {
        try {
          const requestStartedState = get()
          const requestStartedWorktrees = requestStartedState.worktreesByRepo[r.id]
          const hostId = getRepoExecutionHostId(r)
          const setup = getProjectHostSetupForRepoHost(requestStartedState, r.id, hostId)
          const settings = settingsForKnownRepoOwner(requestStartedState.settings, r)
          const parsedHost = parseExecutionHostId(hostId)
          const directSshAuthority =
            parsedHost?.kind === 'ssh'
              ? (getCurrentDirectSshAuthority(requestStartedState, hostId) ?? undefined)
              : undefined
          if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
            await fetchKnownSshWorktreesForRepo(set, r.id, parsedHost.id)
            return
          }
          const refresh = await listDetectedWorktreesForRepoCoalesced(settings, r.id, {
            executionHostId: hostId,
            reuseRecentCompatibilityFailure: true,
            directSshAuthority,
            connectionId: r.connectionId,
            knownWorktreeIds: getKnownWorktreeIdsForPurge(requestStartedState, r.id, hostId)
          })
          if (refresh.status !== 'admitted') {
            return
          }
          mergeFetchedWorktrees(set, {
            repoId: r.id,
            hostId,
            ownerWasMissingAtStart: false,
            requestStartedWorktrees,
            setup,
            refresh
          })
        } catch (err) {
          if (notifyRuntimeScopeForbiddenIfNeeded(err)) {
            return
          }
          console.error(`Failed to fetch worktrees for repo ${r.id}:`, err)
        }
      })
      return
    }

    // Why: a pre-fix upgrade can persist tabsByWorktree entries for worktrees deleted last session; without this hydration purge they leave zombie PTYs misclassified as "bound" (design §2c) until a second restart.
    // Safety gate: fetchWorktrees swallows IPC errors and short-circuits on empty-replace, so probe the IPC directly for the per-repo success signal instead of re-listing.
    const results = await mapReposForWorktreeRefresh(
      repos,
      async (
        r
      ): Promise<
        | { repoId: string; ok: boolean; detected: DetectedWorktreeListResult }
        | { repoId: string; ok: false }
      > => {
        try {
          const requestStartedState = get()
          const requestStartedWorktrees = requestStartedState.worktreesByRepo[r.id]
          const hostId = getRepoExecutionHostId(r)
          const setup = getProjectHostSetupForRepoHost(requestStartedState, r.id, hostId)
          const parsedHost = parseExecutionHostId(hostId)
          const directSshAuthority =
            parsedHost?.kind === 'ssh'
              ? (getCurrentDirectSshAuthority(requestStartedState, hostId) ?? undefined)
              : undefined
          if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
            await fetchKnownSshWorktreesForRepo(set, r.id, parsedHost.id)
            return { repoId: r.id, ok: false as const }
          }
          const refresh = await listDetectedWorktreesForRepoCoalesced(
            settingsForKnownRepoOwner(requestStartedState.settings, r),
            r.id,
            {
              executionHostId: hostId,
              reuseRecentCompatibilityFailure: true,
              directSshAuthority,
              connectionId: r.connectionId,
              knownWorktreeIds: getKnownWorktreeIdsForPurge(requestStartedState, r.id, hostId)
            }
          )
          if (refresh.status !== 'admitted') {
            return { repoId: r.id, ok: false as const }
          }
          const admitted = mergeFetchedWorktrees(set, {
            repoId: r.id,
            hostId,
            ownerWasMissingAtStart: false,
            requestStartedWorktrees,
            setup,
            refresh,
            purgeRemovedWorktrees: false
          })
          if (!admitted) {
            return { repoId: r.id, ok: false as const }
          }
          return {
            repoId: r.id,
            ok: refresh.result.authoritative,
            detected: refresh.result
          }
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
    if (
      options?.hydrationPurge === 'defer' ||
      get().workspaceSessionReady === false ||
      get().hydrationSucceeded === false
    ) {
      // Why: startup refreshes local repos first; defer the one-shot purge to the later all-host refresh, once remote worktree ids are known.
      return
    }
    const validIds = new Set<string>()
    // Why: floating is persisted renderer state, not a repo worktree an authoritative scan returns.
    validIds.add(FLOATING_TERMINAL_WORKTREE_ID)
    // Why: folder workspaces persist tabs under `folder:<id>` keys that authoritative repo scans never return.
    for (const workspace of get().folderWorkspaces ?? []) {
      validIds.add(folderWorkspaceKey(workspace.id))
    }
    for (const key of Object.keys(get().restoredRuntimeHostIdByWorkspaceSessionKey ?? {})) {
      if (parseWorkspaceKey(key)?.type === 'folder') {
        validIds.add(key)
      }
    }
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

  fetchWorktreeLineage: async (options) => {
    try {
      // Why: lineage is a focused-host refresh; host-merge so other hosts' fetched lineage is preserved.
      const ownerSettings = get().settings
      const parsedHost = options?.executionHostId
        ? parseExecutionHostId(options.executionHostId)
        : null
      const activeRuntimeEnvironmentId =
        parsedHost?.kind === 'runtime'
          ? parsedHost.environmentId
          : parsedHost || options?.forceLocalOwner
            ? null
            : ownerSettings?.activeRuntimeEnvironmentId
      const settings = ownerSettings
        ? { ...ownerSettings, activeRuntimeEnvironmentId }
        : ({ activeRuntimeEnvironmentId } as AppState['settings'])
      await refreshWorktreeLineageForSettings(settings, set, {
        reuseRecentCompatibilityFailure: true
      })
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
        // Why: terminal branch switches only patch branch/head here; re-derive auto titles like full listing does.
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
          // Why: linked reviews are branch-scoped; keeping the old link on a branch switch would refresh the old PR.
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
            // Why: a refetch can rehydrate stale linked-review metadata before this async clear starts; clear it again.
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
          // Why: worktree creation can migrate ids mid-IPC; persist the clear under the new durable id too.
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
        // Why: a refetch can rehydrate old metadata before the branch-switch clear reaches disk; don't write the stale link back.
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
      // Why: prefetch is only a latency hedge; the create path awaits the same refresh and owns error reporting.
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
    const linkedWorkItem = options?.linkedWorkItem
    const linkedTaskSourceContext = options?.linkedTaskSourceContext
    const startupDraft = options?.startupDraft
    try {
      for (let attempt = 0; attempt < CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS; attempt += 1) {
        const candidateName = getClientWorktreeCreateCandidate(name, attempt)
        // Why: older runtimes reject exact PR branch overrides on collision, so retry both branch and worktree names.
        const candidateBranchNameOverride = branchNameOverride
          ? getClientWorktreeCreateCandidate(branchNameOverride, attempt)
          : undefined
        try {
          // Why: manual sort is user-authored order; stamp new workspaces at the top rather than relying on sortOrder fallback.
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
            ...(candidateBranchNameOverride
              ? { branchNameOverride: candidateBranchNameOverride }
              : {}),
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
            ...(linkedWorkItem !== undefined ? { linkedWorkItem } : {}),
            ...(linkedTaskSourceContext !== undefined ? { linkedTaskSourceContext } : {}),
            ...(startup ? { startup } : {}),
            ...(creationId ? { creationId } : {}),
            ...(automationProvenanceRequest ? { automationProvenanceRequest } : {})
          }
          const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
          if (
            target.kind === 'environment' &&
            (linkedWorkItem?.provider === 'jira' || linkedTaskSourceContext?.provider === 'jira')
          ) {
            await assertRuntimeEnvironmentCapability(
              target.environmentId,
              WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
              'Update the remote runtime to link Jira'
            )
          }
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
                    ...(candidateBranchNameOverride
                      ? { branchNameOverride: candidateBranchNameOverride }
                      : {}),
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
                    ...(linkedWorkItem !== undefined ? { linkedWorkItem } : {}),
                    ...(linkedTaskSourceContext !== undefined ? { linkedTaskSourceContext } : {}),
                    ...(startupDraft ? { startupDraft } : {}),
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
          // Why: worktrees.onChanged can add this worktree before this callback runs; appending blindly would duplicate it (React key clash).
          set((s) => {
            const hostId = repoHostId(s, repoId)
            const createdWorktree = withRepoHostOwnership(
              result.worktree,
              hostId,
              getProjectHostSetupForRepoHost(s, repoId, hostId)
            )
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
          showLocalBaseRefRefreshToast(result.localBaseRefRefresh, result.worktree)
          if (result.baseFallback) {
            requestWorktreeBaseFallbackNotice(result.baseFallback)
          }
          showLocalBaseRefUpdateSuggestionToast(result.localBaseRefUpdateSuggestion, {
            updateSettings: get().updateSettings,
            getSettings: () => get().settings,
            openSettingsPage: get().openSettingsPage,
            openSettingsTarget: get().openSettingsTarget
          })
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const shouldRetry = isRetryableWorktreeCreateConflict(message)
          if (!shouldRetry || attempt === CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS - 1) {
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
      // Why: the main process re-emits the same phase; skip no-op writes so the strip and panel don't re-render.
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

  removePendingWorktreeCreation: (creationId, options) => {
    set((s) => {
      const entry = s.pendingWorktreeCreations[creationId]
      if (!entry) {
        return {}
      }
      const cleanupVm = options?.cleanupVm ?? true
      if (
        cleanupVm &&
        entry.phase === 'provisioning-vm' &&
        typeof window !== 'undefined' &&
        window.api?.ephemeralVm?.cancelProvision
      ) {
        void window.api.ephemeralVm.cancelProvision({ provisionId: creationId }).catch(() => {
          // Best effort: dismissing the pending surface shouldn't block on a finished or unreachable provisioning process.
        })
      }
      if (
        cleanupVm &&
        entry.request.ephemeralVmRuntimeId &&
        typeof window !== 'undefined' &&
        window.api?.ephemeralVm?.cleanup
      ) {
        void window.api.ephemeralVm
          .cleanup({ runtimeId: entry.request.ephemeralVmRuntimeId })
          .catch(() => {
            // Best effort: cancellation shouldn't block on provider cleanup; Settings still exposes retry/manual cleanup.
          })
      }
      const { [creationId]: _removed, ...rest } = s.pendingWorktreeCreations
      return {
        pendingWorktreeCreations: rest,
        // Why: only clear the active surface if it pointed here, so dismissing a background creation doesn't yank the user away.
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

  removeWorktree: async (worktreeId, force, options) => {
    const forgetLocalOnly = options?.mode === 'forget-local'
    const removalRoute = resolveWorktreeOperationRoute(get(), worktreeId)
    if (!forgetLocalOnly && !removalRoute) {
      return { ok: false, error: WORKTREE_REMOVAL_AMBIGUOUS_ERROR }
    }
    const hostId = removalRoute?.executionHostId ?? undefined
    const removalGenerationGuard = removalRoute
      ? captureWorktreeOperationGenerationGuard(
          get,
          worktreeId,
          removalRoute,
          () => new Error(WORKTREE_REMOVAL_AMBIGUOUS_ERROR)
        )
      : null
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [worktreeId]: {
          isDeleting: true,
          phase: 'deleting',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    }))

    try {
      // Why: forget-local touches no remote, so there's no archive hook to run or trust prompt needed.
      const skipArchive = forgetLocalOnly
        ? true
        : (await ensureHooksConfirmed(
            get(),
            getRepoIdFromWorktreeId(worktreeId),
            'archive',
            hostId,
            removalRoute?.runtimeEnvironmentId
          )) === 'skip'

      const worktreeBeforeRemoval = get()
        .allWorktrees()
        .find((entry) => entry.id === worktreeId)
      const terminalPtyIdsBeforeRemoval = (get().tabsByWorktree[worktreeId] ?? []).flatMap(
        (tab) => get().ptyIdsByTabId[tab.id] ?? []
      )
      if (!forgetLocalOnly) {
        removalGenerationGuard?.assertCurrent()
      }
      // Why: forget-local clears Orca's records via local IPC regardless of host — the remote is gone or unreachable.
      const target = getActiveRuntimeTarget(
        removalRoute
          ? settingsForWorktreeOperationRoute(get().settings, removalRoute)
          : get().settings
            ? { ...get().settings, activeRuntimeEnvironmentId: null }
            : { activeRuntimeEnvironmentId: null }
      )
      let removalResult: RemoveWorktreeResult
      try {
        removalResult = await (forgetLocalOnly
          ? window.api.worktrees.forgetLocal({ worktreeId, hostId })
          : target.kind === 'local'
            ? (removalGenerationGuard?.assertCurrent(),
              window.api.worktrees.remove({
                worktreeId,
                hostId,
                force,
                allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
                skipArchive
              }))
            : (removalGenerationGuard?.assertCurrent(),
              callRuntimeRpc<RemoveWorktreeResult>(
                target,
                'worktree.rm',
                {
                  worktree: toRuntimeWorktreeSelector(worktreeId),
                  ...(hostId ? { hostId } : {}),
                  force,
                  allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
                  runHooks: !skipArchive
                },
                { timeoutMs: 60_000 }
              )))
      } catch (error) {
        if (
          !forgetLocalOnly &&
          target.kind !== 'local' &&
          (isRuntimeRepoNotFoundError(error) || isRuntimeSelectorNotFoundError(error))
        ) {
          // Missing means stale mirror; ambiguous or changed ownership must fail closed.
          const currentResolution = resolveWorktreeOperationRouteResult(get(), worktreeId)
          if (currentResolution.kind === 'ambiguous') {
            throw error
          }
          if (currentResolution.kind === 'resolved') {
            removalGenerationGuard?.assertCurrent()
          }
          try {
            removalResult = await window.api.worktrees.forgetLocal({ worktreeId, hostId })
          } catch (fallbackError) {
            // Preserve the remote verdict as fallback failure context.
            throw new Error(
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              { cause: error }
            )
          }
        } else {
          throw error
        }
      }

      // Why: invalidate stale probes once deletion is authoritative, so an old toast can't mutate a same-path replacement.
      forgetHugeRepoWarningDismissalsForWorktrees([worktreeId])
      // Why: forget-local is legal while the host is unreachable, so record the removal here too — otherwise an
      // in-flight metadata read that snapshotted this row re-appends it, and disconnected polls never drop it.
      if (hostId && parseExecutionHostId(hostId)?.kind === 'ssh') {
        rememberAuthoritativelyRemovedWorktrees(hostId, [worktreeId])
      }

      const worktreeDisplayName = worktreeBeforeRemoval?.displayName?.trim()
      if (worktreeDisplayName) {
        try {
          await window.api.automations?.snapshotWorkspaceName?.({
            workspaceId: worktreeId,
            displayName: worktreeDisplayName
          })
        } catch (error) {
          // Why: snapshotting automation labels is best-effort; a stale preload/test harness must not block removal.
          console.warn('Failed to snapshot automation workspace name:', error)
        }
      }

      // Why: renderer state follows the successful backend result, so blocked dirty deletes keep their terminals intact.
      // Why browsers first: unregister Chromium guests before other teardown can intercept them (avoids a browser-state race).
      await get().shutdownWorktreeBrowsers(worktreeId)
      await get().shutdownWorktreeTerminals(worktreeId, {
        shutdownReason: 'remove-worktree',
        // The backend removal above already killed the workspace's PTYs.
        backendOwnsPtyTeardown: true
      })
      // Why: dispose the SSH relay AFTER terminal teardown so a still-mounted pane can't hit a gone relay and toast "SSH not active".
      const destroyedRuntimeSshTargetIds = await cleanupEphemeralVmRuntimesForDeleted({
        workspaceIds: [worktreeId]
      })
      // Remove the orphaned project for the destroyed SSH target so it can't surface as a dead project in the composer.
      await purgeOrphanedRuntimeSshProjects(get, destroyedRuntimeSshTargetIds)
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const tabIds = new Set(tabs.map((t) => t.id))

      // Why: this path deletes tabsByWorktree wholesale (not via closeTab), so purge the module-level tab maps here too.
      detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
      forgetForegroundTerminalTabs(tabIds)
      forgetAgentStartupDeliveriesForTabs(tabIds)

      // Why: snapshot the sidebar top-row anchor in the same tick we remove the row; recording at click time goes stale across the await.
      requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')

      // Why: dispose parked terminal watchers only on explicit deletion; identity migration/remounts must keep buffered PTY state.
      disposeRemovedWorktreeParkedTerminalWatchers(worktreeId, terminalPtyIdsBeforeRemoval)
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
        const nextAutomaticAgentResumeClaimsByTabId = {
          ...s.automaticAgentResumeClaimsByTabId
        }
        const nextNativeChatLaunchPromptByTabId = { ...s.nativeChatLaunchPromptByTabId }
        const nextNativeChatLaunchDraftByTabId = { ...s.nativeChatLaunchDraftByTabId }
        // Why: closeTab deletes these per-tab maps but removeWorktree missed them, leaking a split pane's expand flags.
        const nextExpandedPaneByTabId = { ...s.expandedPaneByTabId }
        const nextCanExpandPaneByTabId = { ...s.canExpandPaneByTabId }
        for (const tabId of tabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
          delete nextRuntimePaneTitlesByTabId[tabId]
          delete nextAutomaticAgentResumeClaimsByTabId[tabId]
          delete nextNativeChatLaunchPromptByTabId[tabId]
          delete nextNativeChatLaunchDraftByTabId[tabId]
          delete nextExpandedPaneByTabId[tabId]
          delete nextCanExpandPaneByTabId[tabId]
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
        // Why: closeBrowserTab records a Cmd+Shift+T undo snapshot, but a deleted worktree's tabs can't be restored; purge it.
        const nextRecentlyClosedBrowserTabsByWorktree = {
          ...s.recentlyClosedBrowserTabsByWorktree
        }
        delete nextRecentlyClosedBrowserTabsByWorktree[worktreeId]
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        delete nextActiveTabTypeByWorktree[worktreeId]
        const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
        delete nextActiveTabIdByWorktree[worktreeId]
        const nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
        // Why: the tab strip persists visual order per worktree; drop the entry so stale tab IDs aren't retained.
        delete nextTabBarOrderByWorktree[worktreeId]
        const nextPendingReconnectTabByWorktree = { ...s.pendingReconnectTabByWorktree }
        delete nextPendingReconnectTabByWorktree[worktreeId]
        // Why: split-tab layout/group state is worktree-owned; leaving it makes a deleted worktree look restorable.
        const nextUnifiedTabsByWorktree = { ...s.unifiedTabsByWorktree }
        delete nextUnifiedTabsByWorktree[worktreeId]
        const nextGroupsByWorktree = { ...s.groupsByWorktree }
        delete nextGroupsByWorktree[worktreeId]
        const nextLayoutByWorktree = { ...s.layoutByWorktree }
        delete nextLayoutByWorktree[worktreeId]
        const nextActiveGroupIdByWorktree = { ...s.activeGroupIdByWorktree }
        delete nextActiveGroupIdByWorktree[worktreeId]
        // Why: git status/compare caches stop refreshing once the worktree is deleted; remove them so no stale badges/diffs linger.
        const nextGitStatusByWorktree = { ...s.gitStatusByWorktree }
        delete nextGitStatusByWorktree[worktreeId]
        const nextGitStatusHeadByWorktree = { ...s.gitStatusHeadByWorktree }
        delete nextGitStatusHeadByWorktree[worktreeId]
        const nextGitBranchLineTotalByWorktree = { ...s.gitBranchLineTotalByWorktree }
        delete nextGitBranchLineTotalByWorktree[worktreeId]
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
        // Why: clean up per-file editor state for the removed worktree so stale drafts/view modes don't accumulate.
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
        // Why: editorCursorLine is keyed by fileId; clear it with the other per-file state so it doesn't leak.
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
        // Why: clear the huge-status marker so it doesn't linger after the worktree is gone.
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
          automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId,
          nativeChatLaunchPromptByTabId: nextNativeChatLaunchPromptByTabId,
          nativeChatLaunchDraftByTabId: nextNativeChatLaunchDraftByTabId,
          terminalLayoutsByTabId: nextLayouts,
          expandedPaneByTabId: nextExpandedPaneByTabId,
          canExpandPaneByTabId: nextCanExpandPaneByTabId,
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
            // Why: file search state is worktree-scoped; clear it so another worktree can't inherit stale matches.
            delete nextSearch[worktreeId]
            return nextSearch
          })(),
          // Why: these worktree-keyed maps are re-keyed on rename but were missed by removal, leaking one entry each.
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
          recentlyClosedTerminalTabsByWorktree: (() => {
            const next = { ...s.recentlyClosedTerminalTabsByWorktree }
            delete next[worktreeId]
            return next
          })(),
          // Why: a deleted worktree's tabs can never be reopened; purge the kind list with the snapshot stacks above.
          recentlyClosedTabKindsByWorktree: (() => {
            const next = { ...s.recentlyClosedTabKindsByWorktree }
            delete next[worktreeId]
            return next
          })(),
          defaultTerminalTabsAppliedByWorktreeId: (() => {
            const next = { ...s.defaultTerminalTabsAppliedByWorktreeId }
            delete next[worktreeId]
            return next
          })(),
          activeWorktreeId: removedActiveWorktree ? null : s.activeWorktreeId,
          activeWorkspaceExecutionHostId: removedActiveWorktree
            ? null
            : s.activeWorkspaceExecutionHostId,
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
          gitBranchLineTotalByWorktree: nextGitBranchLineTotalByWorktree,
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
      // Why: PR/commit-message generation records are keyed by worktree; prune to the surviving set so they don't leak.
      const liveWorktreeKeys = new Set(
        get()
          .allWorktrees()
          .map((w) => w.id)
      )
      // Optional-chained: minimal store assemblies (some unit tests) omit the generation slices.
      get().prunePullRequestGenerationRecords?.(liveWorktreeKeys)
      get().pruneCommitMessageGenerationRecords?.(liveWorktreeKeys)
      // Why: Source Control may be unmounted during deletion, so it can't be the only stale-draft cleanup path.
      clearSessionCommitDraftForWorktree(worktreeId)
      const preservedBranch = removalResult?.preservedBranch
      const cleanup = preservedBranch
        ? {
            worktreeId,
            branchName: preservedBranch.branchName,
            expectedHead: preservedBranch.head,
            ...(hostId ? { hostId } : {}),
            ...(removalRoute?.runtimeEnvironmentId
              ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
              : {})
          }
        : null
      if (preservedBranch) {
        preservedBranchRuntimeTargetByCleanupKey.set(preservedBranchCleanupKey(cleanup!), {
          cleanup: cleanup!,
          target
        })
      }
      if (preservedBranch && options?.suppressPreservedBranchToast !== true) {
        showPreservedBranchToast(removalResult, worktreeBeforeRemoval, (branch, expectedHead) => {
          void get().forceDeletePreservedBranch(worktreeId, branch, expectedHead, {
            ...(hostId ? { hostId } : {}),
            ...(removalRoute?.runtimeEnvironmentId
              ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
              : {})
          })
        })
      }
      pruneHostedReviewLinkMutationGenerations([worktreeId])
      return preservedBranch && cleanup
        ? {
            ok: true as const,
            preservedBranch: {
              ...preservedBranch,
              ...(cleanup.hostId ? { hostId: cleanup.hostId } : {}),
              ...(cleanup.runtimeEnvironmentId
                ? { runtimeEnvironmentId: cleanup.runtimeEnvironmentId }
                : {})
            }
          }
        : { ok: true as const }
    } catch (err) {
      // Why: git refusing a non-force delete for dirty/untracked files is a handled user decision, not an app error.
      console.warn('Failed to remove worktree:', err)
      const error = err instanceof Error ? err.message : String(err)
      const forceDeleteReason = classifyWorktreeForceDeleteReason(
        error,
        force,
        options?.allowUnverifiedPtyStop === true
      )
      const locked = isLockedWorktreeRemovalError(error)
      set((s) => ({
        deleteStateByWorktreeId: {
          ...s.deleteStateByWorktreeId,
          [worktreeId]: {
            isDeleting: false,
            error,
            canForceDelete: forceDeleteReason !== null,
            forceDeleteReason,
            ...(locked ? { lockReason: getLockedWorktreeRemovalReason(error) } : {})
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
          phase: 'deleting',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
    })
  },

  markWorktreesQueuedForDeletion: (worktreeIds) => {
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
          phase: 'queued',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
    })
  },

  forceDeletePreservedBranch: async (worktreeId, branchName, expectedHead, options) => {
    try {
      const requestedCleanup: PreservedBranchCleanup = {
        worktreeId,
        branchName,
        expectedHead,
        ...(options?.hostId ? { hostId: options.hostId } : {}),
        ...(options?.runtimeEnvironmentId
          ? { runtimeEnvironmentId: options.runtimeEnvironmentId }
          : {})
      }
      const requestedCleanupKey = preservedBranchCleanupKey(requestedCleanup)
      const exactRetainedTarget = preservedBranchRuntimeTargetByCleanupKey.get(requestedCleanupKey)
      const matchingRetainedTargets = exactRetainedTarget
        ? [exactRetainedTarget]
        : [...preservedBranchRuntimeTargetByCleanupKey.values()].filter(
            ({ cleanup }) =>
              cleanup.worktreeId === worktreeId &&
              cleanup.branchName === branchName &&
              cleanup.expectedHead === expectedHead
          )
      const retainedTarget =
        exactRetainedTarget ??
        (options?.hostId || options?.runtimeEnvironmentId || matchingRetainedTargets.length !== 1
          ? undefined
          : matchingRetainedTargets[0])
      if ((options?.hostId || options?.runtimeEnvironmentId) && !retainedTarget) {
        throw new Error(`No preserved branch cleanup is pending for "${branchName}".`)
      }
      const cleanupHostId = options?.hostId ?? retainedTarget?.cleanup.hostId
      // Why: the removed row no longer records its nested HUB owner, so retain the deletion-time route.
      const target =
        retainedTarget?.target ??
        getActiveRuntimeTarget(settingsForWorktreeOwner(get(), worktreeId))
      const result = await (target.kind === 'local'
        ? window.api.worktrees.forceDeletePreservedBranch({
            worktreeId,
            branchName,
            expectedHead,
            ...(cleanupHostId ? { hostId: cleanupHostId } : {})
          })
        : callRuntimeRpc<ForceDeleteWorktreeBranchResult>(
            target,
            'worktree.forceDeleteBranch',
            {
              worktree: toRuntimeWorktreeSelector(worktreeId),
              branchName,
              expectedHead,
              ...(cleanupHostId ? { hostId: cleanupHostId } : {})
            },
            { timeoutMs: 15_000 }
          ))
      if (options?.suppressToast !== true) {
        toast.success(translate('auto.store.slices.worktrees.19db0085fb', 'Local branch deleted'), {
          description: translate(
            'auto.store.slices.worktrees.5a58e03a26',
            'Deleted "{{value0}}".',
            { value0: branchName }
          )
        })
      }
      preservedBranchRuntimeTargetByCleanupKey.delete(
        retainedTarget ? preservedBranchCleanupKey(retainedTarget.cleanup) : requestedCleanupKey
      )
      return { ok: true as const, ...result }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (options?.suppressToast !== true) {
        toast.error(
          translate('auto.store.slices.worktrees.0216895fb5', 'Failed to delete branch'),
          {
            description: error
          }
        )
      }
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
      return { ok: true }
    }
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderUpdates = getFolderWorkspaceMetaUpdates(updates)
      if (Object.keys(folderUpdates).length === 0) {
        return { ok: true }
      }
      try {
        // Why: a rejected folder update reconciles the optimistic write away, so
        // reporting ok would show the dialog a save that silently undid itself.
        const updated = await get().updateFolderWorkspace(
          workspaceScope.folderWorkspaceId,
          folderUpdates
        )
        return updated
          ? { ok: true }
          : {
              ok: false,
              error: translate(
                'auto.store.slices.worktrees.a17f4d2e93',
                'Could not update this workspace.'
              )
            }
      } catch (err) {
        console.error('Failed to update folder workspace meta:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    const normalizedUpdates = existingWorktree
      ? clearOlderHostedReviewLinksForReplacement(updates, existingWorktree)
      : updates
    // Why: manual PR linking supplies only the number; resolve the head branch so Push targets the review branch.
    const linkedPrForPushTarget = isPositiveHostedReviewNumber(normalizedUpdates.linkedPR)
      ? normalizedUpdates.linkedPR
      : null
    const resolvedPushTarget =
      linkedPrForPushTarget !== null &&
      normalizedUpdates.pushTarget === undefined &&
      existingWorktree &&
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
    // Why: a pushTarget derived from a linked review must not keep steering pushes after it's unlinked or replaced.
    const shouldClearStaleHostedReviewPushTarget =
      Boolean(existingWorktree?.pushTarget) &&
      normalizedUpdates.pushTarget === undefined &&
      resolvedPushTarget === undefined &&
      existingHostedReviewPushTargetLookup !== null &&
      existingHostedReviewPushTargetLookup.key !== nextHostedReviewPushTargetLookup?.key
    const worktreeForUpdate = get().getKnownWorktreeById(worktreeId)
    if (shouldApplyUpdate && !shouldApplyUpdate(worktreeForUpdate)) {
      return { ok: true }
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

    // Why: bump lastActivityAt on comment edits so the time-decay sort doesn't drop a just-touched worktree.
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
      return { ok: true }
    }
    if (hasHostedReviewLinkUpdates(enriched)) {
      bumpHostedReviewLinkMutationGeneration(worktreeId)
    }

    try {
      await persistWorktreeMeta(settingsForWorktreeOwner(get(), worktreeId), worktreeId, enriched)
      if (
        !options?.suppressHostedReviewRefresh &&
        reviewRepo &&
        reviewBranch &&
        typeof get().fetchHostedReviewForBranch === 'function'
      ) {
        // Why: refetch against post-update links so a cache entry from the previous provider link can't keep showing the removed review.
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
        return {
          ok: false,
          error: translate(
            'auto.store.slices.worktrees.c6cf133786',
            'This workspace is no longer available.'
          )
        }
      }
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      // Why: the refetch above reverts the optimistic write, so a caller that
      // closes its surface on this path shows the user a save that undid itself.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true }
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
      // Why: restore the review head push target so push/status stay aligned after metadata loss.
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
    // Only follow a toggled row with the viewport when it's the focused worktree, not an unfocused card.
    const activeSidebarWorktreeId = getActiveSidebarWorkspaceId(
      get().activeWorkspaceKey,
      get().activeWorktreeId
    )
    // Skip worktrees already in the target state so a no-op toggle doesn't scroll the viewport away.
    const updates = new Map<string, Partial<WorktreeMeta>>()
    let didChange = false
    let revealWorktreeId: string | null = null
    for (const worktreeId of worktreeIds) {
      const current = get().getKnownWorktreeById(worktreeId)
      if (!current || current.isPinned === isPinned) {
        continue
      }
      didChange = true
      const workspaceScope = parseWorkspaceKey(worktreeId)
      if (workspaceScope?.type === 'folder') {
        void get().updateWorktreeMeta(worktreeId, { isPinned })
      } else {
        updates.set(worktreeId, { isPinned })
      }
      if (revealWorktreeId === null && worktreeId === activeSidebarWorktreeId) {
        revealWorktreeId = worktreeId
      }
    }
    if (!didChange) {
      return
    }
    // updateWorktreesMeta applies the store update synchronously, so the reveal below sees the row already rendered.
    void get().updateWorktreesMeta(updates)
    if (revealWorktreeId !== null) {
      get().revealWorktreeInSidebar(revealWorktreeId, { behavior: 'smooth', highlight: true })
    }
  },

  markWorktreeUnread: (worktreeId) => {
    // Why: attention dot stays until the user engages the worktree; cleared by pane interaction or activation.
    const now = Date.now()
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderWorkspaceId = workspaceScope.folderWorkspaceId
      let shouldPersist = false
      set((s) => {
        const folderWorkspace = s.folderWorkspaces.find(
          (workspace) => workspace.id === folderWorkspaceId
        )
        if (!folderWorkspace || folderWorkspace.isUnread) {
          return s
        }
        shouldPersist = true
        return {
          folderWorkspaces: s.folderWorkspaces.map((workspace) =>
            workspace.id === folderWorkspaceId
              ? { ...workspace, isUnread: true, lastActivityAt: now }
              : workspace
          ),
          sortEpoch: s.sortEpoch + 1
        }
      })
      if (!shouldPersist) {
        return
      }
      void get().updateFolderWorkspace(folderWorkspaceId, {
        isUnread: true,
        lastActivityAt: now
      })
      return
    }
    let shouldPersist = false
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

    persistPassiveWorktreeMetaForOwner(
      get,
      worktreeId,
      { isUnread: true, lastActivityAt: now },
      'persist unread worktree state'
    )
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
          // Why: terminal output can carry arbitrary PR URLs (docs/agents/logs).
          // Persist only after branch lookup confirms it and the user hasn't picked another PR mid-flight.
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
      // Why: full app stores have fetchPRForBranch (syncs the hosted-review cache); this is only a slice-test fallback.
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
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderWorkspaceId = workspaceScope.folderWorkspaceId
      const folderWorkspace = get().folderWorkspaces.find(
        (workspace) => workspace.id === folderWorkspaceId
      )
      if (!folderWorkspace?.isUnread) {
        return
      }
      // Why: flip locally first — this runs per keystroke, so the guard above must dedupe before the IPC round-trip lands.
      set((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace.id === folderWorkspaceId ? { ...workspace, isUnread: false } : workspace
        )
      }))
      void get().updateFolderWorkspace(folderWorkspaceId, { isUnread: false })
      return
    }
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree || !worktree.isUnread) {
        // Why: return `s` (not {}) to keep the object reference on this hot-path no-op (every keystroke), avoiding selector churn.
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

    persistPassiveWorktreeMetaForOwner(
      get,
      worktreeId,
      { isUnread: false },
      'persist cleared unread worktree state'
    )
  },

  bumpWorktreeActivity: (worktreeId) => {
    const now = Date.now()
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      // Why: folder meta lives on the FolderWorkspace record — persistWorktreeMeta would write a
      // worktreeMeta['folder:…'] row that folderWorkspaces:list never reads back (#10251).
      const folderWorkspaceId = workspaceScope.folderWorkspaceId
      let shouldPersist = false
      set((s) => {
        if (!s.folderWorkspaces.some((workspace) => workspace.id === folderWorkspaceId)) {
          return s
        }
        shouldPersist = true
        const isActive = s.activeWorktreeId === worktreeId
        return {
          folderWorkspaces: s.folderWorkspaces.map((workspace) =>
            workspace.id === folderWorkspaceId ? { ...workspace, lastActivityAt: now } : workspace
          ),
          // Why: active-workspace PTY events are click side-effects, so they must not reorder it.
          ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
        }
      })
      if (shouldPersist) {
        getFolderWorkspaceActivityPersistence(get).record(folderWorkspaceId, now)
      }
      return
    }
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree) {
        return {}
      }
      shouldPersist = true
      // Why: skip sortEpoch bump for the active worktree — its PTY events are click side-effects (reorder-on-click bug, PR #209).
      // lastActivityAt is still persisted so the next background-driven sortEpoch bump includes this worktree's score.
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

    const ownerSettings = trySettingsForWorktreeOwner(get(), worktreeId)
    if (!ownerSettings) {
      warnAmbiguousOwnerOnce(worktreeId, 'persist worktree activity timestamp')
      return
    }
    void persistWorktreeMeta(ownerSettings, worktreeId, {
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
    // Why: Cmd+J empty-query ordering needs a focus-recency signal distinct from lastActivityAt (background PTY/activity).
    // Monotonic: CLI/IPC activations can race, so older timestamps must not regress. See docs/cmd-j-empty-query-ordering.md.
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
      // Why: prune per-repo, not globally — SSH repos aren't hydrated at startup, so a global prune would wipe SSH focus-recency.
      // Only drop for repos with a populated/authoritative list; a missing repoId means not-yet-hydrated (defer).
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
      const patch: {
        lastVisitedAtByWorktreeId?: Record<string, number>
        activeWorktreeId?: null
        activeWorkspaceExecutionHostId?: null
      } = {}
      if (changed) {
        patch.lastVisitedAtByWorktreeId = next
      }
      // Why: the persisted active-worktree pointer is a `${repoId}::${path}` id
      // that nothing else reconciles here. The main-process Store clears a stale
      // pointer when a repo is removed (removeWorkspaceSessionOwner nulls
      // activeWorktreeId), but the web client keeps it in localStorage and gets
      // no such load-time GC — so a pointer to a worktree the server no longer
      // reports lingers and can surface a phantom/duplicate workspace. Clear it
      // once its repo is hydrated and the worktree is confirmed gone (defer while
      // the repo is unhydrated, mirroring the timestamp rule above).
      const activeId = s.activeWorktreeId
      if (activeId) {
        const activeRepoWorktreeIds = validIdsByRepo.get(getRepoIdFromWorktreeId(activeId))
        if (activeRepoWorktreeIds && !activeRepoWorktreeIds.has(activeId)) {
          patch.activeWorktreeId = null
          patch.activeWorkspaceExecutionHostId = null
        }
      }
      return Object.keys(patch).length > 0 ? patch : {}
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

  remountTerminalTabForRecovery: (tabId) => {
    let remounted = false
    set((s) => {
      for (const [worktreeId, tabs] of Object.entries(s.tabsByWorktree)) {
        const index = tabs.findIndex((tab) => tab.id === tabId)
        if (index === -1) {
          continue
        }
        const tab = tabs[index]
        const nextTabs = tabs.slice()
        nextTabs[index] = {
          ...tab,
          // Why: bump generation to remount a pane whose renderer died while its PTY stayed alive, so it reattaches, not spawns.
          generation: (tab.generation ?? 0) + 1,
          // Why: recovery isn't a user interaction — suppress its PTY updates from reshuffling Recent, like activation remounts.
          pendingActivationSpawn: getTerminalActivationSpawnSuppression(
            s.terminalLayoutsByTabId[tab.id]
          )
        }
        remounted = true
        return {
          tabsByWorktree: {
            ...s.tabsByWorktree,
            [worktreeId]: nextTabs
          }
        }
      }
      return {}
    })
    return remounted
  },

  setActiveWorktree: (worktreeId, executionHostId, options) => {
    const stateTransition = options?.stateTransition?.(get())
    if (stateTransition && !stateTransition.activate) {
      if (Object.keys(stateTransition.patch).length > 0) {
        set(stateTransition.patch)
      }
      return false
    }
    const workspaceScope = worktreeId ? parseWorkspaceKey(worktreeId) : null
    if (worktreeId && shouldDeferActivationTerminalPrep()) {
      markInputQuietSchedulerInput()
    }

    if (get().activeWorktreeId !== worktreeId) {
      moveFocusToRendererBeforeFocusedWebviewHidden()
    }
    let shouldClearUnread = false
    let shouldPrepareTerminalTabs = false
    let shouldTagTerminalTabs = false
    set((current) => {
      const transitioned = stateTransition
        ? ({ ...current, ...stateTransition.patch } as AppState)
        : current
      const reconciliation = worktreeId
        ? projectWorktreeTabModelReconciliation(transitioned, worktreeId)
        : null
      const reconciliationChanged = Boolean(
        reconciliation && Object.keys(reconciliation.patch).length > 0
      )
      const s =
        reconciliation && reconciliationChanged
          ? ({ ...transitioned, ...reconciliation.patch } as AppState)
          : transitioned
      const reconciledActiveTabId = reconciliation?.activeRenderableTabId ?? null
      if (!worktreeId) {
        return {
          ...stateTransition?.patch,
          activeWorktreeId: null,
          activeWorkspaceKey: null,
          activeWorkspaceExecutionHostId: null,
          // Why: clearing/activating a worktree must dismiss the background-creation panel so the user isn't stranded on it.
          activePendingCreationId: null
        }
      }

      const worktree = findKnownWorktreeById(s, worktreeId, executionHostId)
      shouldClearUnread = Boolean(worktree?.isUnread)

      // Why: Search lives under Explorer, so the files/search sub-route must switch with the worktree, not leak the prior one.
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
      const activeUnifiedTabId =
        stateTransition?.preferredActiveUnifiedTabId ??
        reconciledActiveTabId ??
        activeGroup?.activeTabId ??
        null
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

      // Why: restore from the reconciled tab-group model first; preferring legacy fallbacks can show a blank worktree.
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

      // Why: restore the last-active terminal tab so the user returns to where they left, not tab 0.
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

      // Why: focus isn't smart-sort activity — writing lastActivityAt here caused the "jump after focus" bug; only clear unread.
      const metaUpdates: Partial<WorktreeMeta> = shouldClearUnread ? { isUnread: false } : {}

      // Why: prep is deferred (shell render deferred below) so it waits for input quiet instead of blocking the click.
      // Why first-activation guard, not tab.ptyId==null: reconnectPersistedTerminals repopulates ptyId before mount.
      // Tag every tab on FIRST activation so reattach/fresh-spawn updateTabPtyId suppresses activity + sortEpoch bumps.
      // Generation is only bumped when no tab has a live PTY — a live remount would kill the user's shell.
      const tabs = s.tabsByWorktree[worktreeId ?? ''] ?? []
      const allDead =
        worktreeId != null &&
        tabs.length > 0 &&
        tabs.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
      const isFirstActivation = worktreeId != null && !s.everActivatedWorktreeIds.has(worktreeId)
      const shouldTagTabs = worktreeId != null && tabs.length > 0 && isFirstActivation
      // Why: bump generation in the same set() as activation so a dead-transport pane can't go visible-but-dead before remount.
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
      const nextFolderWorkspaces =
        shouldClearUnread && workspaceScope?.type === 'folder'
          ? s.folderWorkspaces.map((workspace) =>
              workspace.id === workspaceScope.folderWorkspaceId
                ? { ...workspace, isUnread: false }
                : workspace
            )
          : s.folderWorkspaces
      const nextActiveRepoId =
        workspaceScope?.type === 'folder'
          ? null
          : stateTransition
            ? (worktree?.repoId ?? s.activeRepoId)
            : s.activeRepoId
      const tabsByWorktreeUpdate =
        allDead && worktreeId != null
          ? {
              tabsByWorktree: {
                ...s.tabsByWorktree,
                [worktreeId]: tabs.map((tab) => ({
                  ...tab,
                  generation: (tab.generation ?? 0) + 1,
                  pendingActivationSpawn: getTerminalActivationSpawnSuppression(
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
        s.activeWorkspaceExecutionHostId !== (executionHostId ?? null) ||
        // Why: a pending-creation panel can show over the prior worktree; a non-null activePendingCreationId counts as a change.
        s.activePendingCreationId !== null ||
        s.activeFileId !== activeFileId ||
        s.activeBrowserTabId !== activeBrowserTabId ||
        s.activeTabType !== activeTabType ||
        s.rightSidebarExplorerView !== restoredRightSidebarExplorerView ||
        s.activeTabId !== activeTabId ||
        nextActiveTabTypeByWorktree !== s.activeTabTypeByWorktree ||
        nextEverActivated !== s.everActivatedWorktreeIds ||
        nextWorktrees !== s.worktreesByRepo ||
        nextDetectedWorktrees !== s.detectedWorktreesByRepo ||
        nextFolderWorkspaces !== s.folderWorkspaces ||
        nextActiveRepoId !== s.activeRepoId ||
        reconciliationChanged ||
        stateTransition !== undefined
      if (!hasStateChange) {
        // Why: preserve the root Zustand reference on a no-op re-activation so session persistence/runtime sync don't fan out.
        return s
      }

      return {
        ...stateTransition?.patch,
        ...reconciliation?.patch,
        activeRepoId: nextActiveRepoId,
        activeWorktreeId: worktreeId,
        activeWorkspaceKey: isWorkspaceKey(worktreeId)
          ? worktreeId
          : worktreeWorkspaceKey(worktreeId),
        activeWorkspaceExecutionHostId: executionHostId ?? null,
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
        ...(nextFolderWorkspaces !== s.folderWorkspaces
          ? { folderWorkspaces: nextFolderWorkspaces }
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
                // Why: slept terminal remount/spawn is click-driven wake work; tag its PTY updates so they don't reshuffle Recent.
                pendingActivationSpawn: getTerminalActivationSpawnSuppression(
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

    // Why: activation is explicit enough to revalidate PR state now; the coordinator still coalesces and rate-guards.
    if (worktreeId) {
      get().refreshGitHubForWorktreeIfStale(worktreeId)
    }

    if (!worktreeId || !get().getKnownWorktreeById(worktreeId, executionHostId)) {
      return true
    }

    if (shouldClearUnread) {
      if (workspaceScope?.type === 'folder') {
        void get().updateFolderWorkspace(workspaceScope.folderWorkspaceId, { isUnread: false })
        return true
      }
      persistPassiveWorktreeMetaForOwner(
        get,
        worktreeId,
        { isUnread: false },
        'persist worktree activation state'
      )
    }
    return true
  },

  setActiveFolderWorkspace: (folderWorkspaceId, executionHostId) => {
    const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
    const workspace = findKnownWorktreeById(get(), workspaceKey, executionHostId)
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
        activeWorkspaceExecutionHostId: executionHostId ?? null,
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
              entry.id === folderWorkspaceId &&
              (!executionHostId || folderWorkspaceMatchesHost(entry, executionHostId))
                ? { ...entry, isUnread: false }
                : entry
            )
          : s.folderWorkspaces
      }
    })
    if (workspace.isUnread) {
      void get().updateFolderWorkspace(
        folderWorkspaceId,
        { isUnread: false },
        executionHostId ? { executionHostId } : undefined
      )
    }
  },

  allWorktrees: () => Object.values(get().worktreesByRepo).flat(),

  getKnownWorktreeById: (worktreeId, executionHostId) =>
    findKnownWorktreeById(get(), worktreeId, executionHostId),

  purgeWorktreeTerminalState: (worktreeIds: string[]) => {
    const purgeableWorktreeIds = worktreeIds.filter((id) => id !== FLOATING_TERMINAL_WORKTREE_ID)
    if (purgeableWorktreeIds.length === 0) {
      return
    }
    set((s) => buildWorktreePurgeState(s, purgeableWorktreeIds))
  },

  purgeStaleRuntimeHostState: (removedEnvironmentIds) => {
    const removed = new Set(removedEnvironmentIds)
    if (removed.size === 0) {
      return
    }
    set((s) => {
      const repoIdsWithRemovedOwners = new Set<string>()
      const survivingRepoIds = new Set<string>()
      const repoIdsWithSurvivingOwners = new Set<string>()
      const survivingRepos: Repo[] = []
      for (const repo of s.repos) {
        if (isRemovedRuntimeHostId(getRepoExecutionHostId(repo), removed)) {
          repoIdsWithRemovedOwners.add(repo.id)
        } else {
          survivingRepos.push(repo)
          survivingRepoIds.add(repo.id)
          repoIdsWithSurvivingOwners.add(repo.id)
        }
      }
      const reposChanged = survivingRepos.length !== s.repos.length

      // Why: a repoId-less setup on the removed host can still split a surviving project group, so drop every setup it owns.
      const survivingSetups: ProjectHostSetup[] = []
      for (const setup of s.projectHostSetups) {
        if (isRemovedRuntimeHostId(setup.hostId, removed)) {
          if (setup.repoId) {
            repoIdsWithRemovedOwners.add(setup.repoId)
          }
        } else {
          survivingSetups.push(setup)
          if (setup.repoId) {
            repoIdsWithSurvivingOwners.add(setup.repoId)
          }
        }
      }
      const setupsChanged = survivingSetups.length !== s.projectHostSetups.length
      const detectedRows: Record<string, DetectedWorktreeListResult['worktrees']> =
        Object.fromEntries(
          Object.entries(s.detectedWorktreesByRepo).map(([repoId, result]) => [
            repoId,
            result.worktrees
          ])
        )
      // Why: repo/setup catalogs can lag session hydration, so hosted worktree rows are ownership evidence during that gap.
      const recordWorktreeOwners = (
        rowsByRepo: Record<
          string,
          readonly { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }[]
        >
      ): void => {
        for (const [repoId, rows] of Object.entries(rowsByRepo)) {
          for (const row of rows) {
            if (!row.hostId && !row.runtimeOwnerEnvironmentId) {
              continue
            }
            const ownerWasRemoved = row.runtimeOwnerEnvironmentId
              ? removed.has(row.runtimeOwnerEnvironmentId)
              : isRemovedRuntimeHostId(row.hostId, removed)
            const ownerSet = ownerWasRemoved ? repoIdsWithRemovedOwners : repoIdsWithSurvivingOwners
            ownerSet.add(repoId)
          }
        }
      }
      recordWorktreeOwners(s.worktreesByRepo)
      recordWorktreeOwners(detectedRows)

      const sessionWorktreeIdsOwnedByRemovedHosts = new Set<string>()
      let survivingRestoredSessionOwners = s.restoredRuntimeHostIdByWorkspaceSessionKey
      for (const [workspaceKey, hostId] of Object.entries(
        s.restoredRuntimeHostIdByWorkspaceSessionKey
      )) {
        const scope = parseWorkspaceKey(workspaceKey)
        if (scope?.type === 'folder') {
          continue
        }
        const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceKey
        const repoId = getRepoIdFromWorktreeId(worktreeId)
        if (!isRemovedRuntimeHostId(hostId, removed)) {
          // Why: restored sessions can be the only surviving-owner evidence before catalogs load.
          repoIdsWithSurvivingOwners.add(repoId)
          continue
        }
        sessionWorktreeIdsOwnedByRemovedHosts.add(worktreeId)
        repoIdsWithRemovedOwners.add(repoId)
        if (survivingRestoredSessionOwners === s.restoredRuntimeHostIdByWorkspaceSessionKey) {
          survivingRestoredSessionOwners = { ...survivingRestoredSessionOwners }
        }
        delete survivingRestoredSessionOwners[workspaceKey]
      }

      // Why: legacy rows predate host stamps; every owner record must agree no host survives before an unhosted row is retired.
      const repoIdsWithoutSurvivingOwners = new Set(repoIdsWithRemovedOwners)
      for (const repoId of repoIdsWithSurvivingOwners) {
        repoIdsWithoutSurvivingOwners.delete(repoId)
      }

      const worktreeDrop = dropWorktreeRowsForRemovedRuntimeEnvironments(
        s.worktreesByRepo,
        removed,
        repoIdsWithoutSurvivingOwners
      )
      const detectedDrop = dropWorktreeRowsForRemovedRuntimeEnvironments(
        detectedRows,
        removed,
        repoIdsWithoutSurvivingOwners
      )

      const worktreesChanged = worktreeDrop.rowsByRepo !== s.worktreesByRepo
      const detectedChanged = detectedDrop.rowsByRepo !== detectedRows

      const removedWorktreeIds = new Set([
        ...worktreeDrop.removedWorktreeIds,
        ...detectedDrop.removedWorktreeIds,
        ...sessionWorktreeIdsOwnedByRemovedHosts
      ])
      // Why: terminal tabs hydrate before worktree metadata, so session-only ids for owner-less repos still need purging.
      if (repoIdsWithoutSurvivingOwners.size > 0) {
        for (const worktreeId of Object.keys(s.tabsByWorktree)) {
          const scope = parseWorkspaceKey(worktreeId)
          const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
          if (
            scope?.type !== 'folder' &&
            repoIdsWithoutSurvivingOwners.has(getRepoIdFromWorktreeId(rawWorktreeId))
          ) {
            removedWorktreeIds.add(rawWorktreeId)
          }
        }
      }
      // Why: bare-id state follows an exact survivor unless the restored-session partition proves it belonged to the removed host.
      for (const rows of Object.values(worktreeDrop.rowsByRepo)) {
        for (const row of rows) {
          if (!sessionWorktreeIdsOwnedByRemovedHosts.has(row.id)) {
            removedWorktreeIds.delete(row.id)
          }
        }
      }
      for (const rows of Object.values(detectedDrop.rowsByRepo)) {
        for (const row of rows) {
          if (!sessionWorktreeIdsOwnedByRemovedHosts.has(row.id)) {
            removedWorktreeIds.delete(row.id)
          }
        }
      }
      const purgeState =
        removedWorktreeIds.size > 0 ? buildWorktreePurgeState(s, [...removedWorktreeIds]) : {}

      const restoredSessionOwnersChanged =
        survivingRestoredSessionOwners !== s.restoredRuntimeHostIdByWorkspaceSessionKey
      if (
        !reposChanged &&
        !setupsChanged &&
        !worktreesChanged &&
        !detectedChanged &&
        !restoredSessionOwnersChanged &&
        removedWorktreeIds.size === 0
      ) {
        return s
      }

      const detectedWorktreesByRepo = detectedChanged
        ? Object.fromEntries(
            Object.entries(s.detectedWorktreesByRepo).map(([repoId, result]) => [
              repoId,
              { ...result, worktrees: detectedDrop.rowsByRepo[repoId] }
            ])
          )
        : s.detectedWorktreesByRepo

      const rowsChanged = worktreesChanged || detectedChanged
      return {
        ...purgeState,
        ...(reposChanged ? { repos: survivingRepos } : {}),
        ...(setupsChanged ? { projectHostSetups: survivingSetups } : {}),
        ...(worktreesChanged ? { worktreesByRepo: worktreeDrop.rowsByRepo } : {}),
        ...(detectedChanged ? { detectedWorktreesByRepo } : {}),
        ...(restoredSessionOwnersChanged
          ? { restoredRuntimeHostIdByWorkspaceSessionKey: survivingRestoredSessionOwners }
          : {}),
        ...(rowsChanged ? { sortEpoch: s.sortEpoch + 1 } : {}),
        // Why: mirror validateRepoScopedUi so a filtered/active sidebar can't reference a purged repo id.
        ...(reposChanged
          ? {
              activeRepoId:
                s.activeRepoId && survivingRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
              filterRepoIds: s.filterRepoIds.filter((repoId) => survivingRepoIds.has(repoId))
            }
          : {})
      }
    })
  },

  migrateWorktreeIdentity: (oldWorktreeId: string, newWorktreeId: string) => {
    if (oldWorktreeId === newWorktreeId) {
      return
    }
    // Why: invalidate pre-rename toast actions before publishing the new path, carrying the dismissal forward.
    migrateHugeRepoWarningDismissal(oldWorktreeId, newWorktreeId)
    set((s) => buildWorktreeRenameState(s, oldWorktreeId, newWorktreeId))
    migrateHostedReviewLinkMutationGeneration(oldWorktreeId, newWorktreeId)
  }
})
