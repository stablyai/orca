import type { StateCreator } from 'zustand'
import { appliedWorktreeCatalogVersionPatch } from './worktree-catalog-version-state'
import type { AppState } from '../../../types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { routeListingBranchSwitchesThroughGitIdentity } from '../../worktree-listing-branch-switch'
import {
  areDetectedWorktreeResultsEqual,
  areWorktreesEqual,
  worktreesDifferOnlyInSortOrder
} from './worktree-catalog-visibility'
import { mergeDetectedWorktreesForHost } from './detected-worktree-host-merge'
import {
  getRemovedWorktreeIdsAfterAuthoritativeScan,
  mergeWorktreesForHost,
  toVisibleWorktrees,
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from './worktree-host-ownership'
import {
  hasBranchScopedHostedReviewContext,
  sanitizeHostedReviewLinksForBranchClears
} from '../metadata/hosted-review-link-mutation'
import {
  worktreeListingRefusal,
  type WorktreeListingMergeOutcome
} from './detected-worktree-refresh-admission'
import { buildWorktreePurgeState } from '../teardown/worktree-purge-state'
import { flushPurgedWorkspaceEdits } from '../teardown/removed-workspace-unsaved-files'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import { isDisplayNamePersistencePending } from '../metadata/worktree-meta-persist'
import { branchName } from '@/lib/git-utils'
import {
  forgetAuthoritativelyRemovedWorktrees,
  forgetPersistedWorktreeMetaForRemovals,
  rememberAuthoritativelyRemovedWorktrees
} from './authoritative-worktree-removal-memory'
import type { FencedWorktreeMergeArgs } from './worktree-slice-types'

export function preserveConcurrentManualOrder<T extends Worktree>(
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

export function preserveConcurrentDisplayName<T extends Worktree>(
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
    if (!started || !latest) {
      return worktree
    }
    if (isDisplayNamePersistencePending(worktree.id, latest.hostId)) {
      return {
        ...worktree,
        displayName: latest.displayName,
        ...(latest.displayNameMode !== undefined
          ? { displayNameMode: latest.displayNameMode }
          : { displayNameMode: undefined })
      }
    }
    const latestChanged =
      latest.displayName !== started.displayName ||
      latest.displayNameMode !== started.displayNameMode
    // The label is the stable stale-response marker; mode may be absent on an
    // older host or newly projected by a newer one.
    const incomingIsStale = worktree.displayName === started.displayName
    const latestDisplayNameIsPinned =
      latest.displayNameMode === 'fixed' ||
      (latest.displayNameMode === undefined && latest.cliProvenance?.kind === 'created-by-cli')
    const incomingBranchShort = branchName(worktree.branch)
    // Old hosts re-derive automatic labels from branch (or path basename when detached);
    // any other label in their response is explicit meta a peer wrote there.
    const incomingLooksAutomatic =
      worktree.displayName === incomingBranchShort ||
      (incomingBranchShort === '' &&
        worktree.displayName === (worktree.path.split(/[\\/]/).pop() ?? ''))
    if (
      worktree.displayNameMode === undefined &&
      latestDisplayNameIsPinned &&
      incomingLooksAutomatic
    ) {
      // Older hosts omit provenance; never let their re-derived label replace a pinned one.
      return {
        ...worktree,
        displayName: latest.displayName,
        ...(latest.displayNameMode !== undefined
          ? { displayNameMode: latest.displayNameMode }
          : { displayNameMode: undefined })
      }
    }
    if (!latestChanged || !incomingIsStale) {
      return worktree
    }
    return {
      ...worktree,
      displayName: latest.displayName,
      ...(latest.displayNameMode !== undefined
        ? { displayNameMode: latest.displayNameMode }
        : { displayNameMode: undefined })
    }
  })
}

export function mergeFetchedWorktrees(
  _set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  get: () => AppState,
  args: FencedWorktreeMergeArgs
): WorktreeListingMergeOutcome {
  if (args.purgeRemovedWorktrees !== false) {
    // Why before the updater: delayed views must commit text the purge may offer back.
    const state = get()
    flushPurgedWorkspaceEdits(
      state,
      getRemovedWorktreeIdsAfterAuthoritativeScan(
        state,
        args.repoId,
        args.refresh.result,
        args.hostId
      ).map((id) => hostWorktreeTarget({ id, hostId: args.hostId }))
    )
  }
  // Why a holder: the updater decides the outcome, and a narrowed `let` would hide that assignment.
  const decision: { outcome: WorktreeListingMergeOutcome } = { outcome: 'not-current' }
  let authoritativelyRemovedIds: readonly string[] = []
  let authoritativelySeenIds: readonly string[] = []
  get().updateAgentStatusState((s, changedPaneKeys) => {
    // Check live applied catalog before any row/detection/purge merge so in-flight listings cannot undo newer create/remove replies.
    const refusal = worktreeListingRefusal(
      s,
      args.refresh,
      args.repoId,
      args.hostId,
      args.ownerWasMissingAtStart &&
        (!args.refresh.directSshAuthority || s.repos === args.missingDirectSshOwnerReposSnapshot)
    )
    if (refusal) {
      decision.outcome = refusal
      return s
    }
    decision.outcome = 'applied'
    const matchOptions = worktreeHostMatchOptions(s, args.repoId, args.hostId)
    const currentWorktrees = s.worktreesByRepo[args.repoId]
    const refreshResult = {
      ...args.refresh.result,
      worktrees: preserveConcurrentDisplayName(
        preserveConcurrentManualOrder(
          args.refresh.result.worktrees,
          args.requestStartedWorktrees,
          currentWorktrees,
          (worktree) => worktreeMatchesHost(worktree, args.hostId, matchOptions)
        ),
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
    // Stored rows from a stopped WSL distro lack branch state the scanned rows already have.
    const keepCurrent = worktrees.length === 0 || !!args.refresh.result.wslDistroStopped
    if (!args.refresh.result.authoritative && keepCurrent && currentForHost.length > 0) {
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
    const versionPatch = appliedWorktreeCatalogVersionPatch(
      s,
      args.repoId,
      args.hostId,
      args.refresh.result.catalogVersion
    )
    if (
      !worktreesChanged &&
      !detectedChanged &&
      removedIds.length === 0 &&
      Object.keys(versionPatch).length === 0
    ) {
      return s
    }
    return {
      ...versionPatch,
      ...(worktreesChanged
        ? {
            worktreesByRepo: {
              ...s.worktreesByRepo,
              [args.repoId]: mergedWorktrees
            },
            // Why: an order save re-reads as a sortOrder-only change; re-sorting on it would schedule the next save (#27268).
            ...(worktreesDifferOnlyInSortOrder(s.worktreesByRepo[args.repoId], mergedWorktrees)
              ? { sortOrderEpoch: s.sortOrderEpoch + 1 }
              : { sortEpoch: s.sortEpoch + 1 })
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
      ...(removedIds.length > 0
        ? buildWorktreePurgeState(
            s,
            removedIds.map((id) => hostWorktreeTarget({ id, hostId: args.hostId })),
            changedPaneKeys
          )
        : {})
    }
  })
  if (decision.outcome === 'applied') {
    // Why: applied outside the updater so a repeated updater call cannot double-apply the removal memory.
    forgetAuthoritativelyRemovedWorktrees(args.hostId, authoritativelySeenIds)
    rememberAuthoritativelyRemovedWorktrees(args.hostId, authoritativelyRemovedIds)
    // Retire metadata only on real scans; legacy session-fallback claims authority but truncates/filter rows, so omissions prove no deletion.
    forgetPersistedWorktreeMetaForRemovals(
      args.repoId,
      args.hostId,
      args.refresh.result.source === 'git' ? authoritativelyRemovedIds : []
    )
  }
  return decision.outcome
}
