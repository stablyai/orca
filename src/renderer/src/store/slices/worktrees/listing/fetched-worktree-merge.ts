import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { routeListingBranchSwitchesThroughGitIdentity } from '../../worktree-listing-branch-switch'
import { areDetectedWorktreeResultsEqual, areWorktreesEqual } from './worktree-catalog-visibility'
import { mergeDetectedWorktreesForHost } from './detected-worktree-host-merge'
import {
  getRemovedWorktreeIdsAfterAuthoritativeScan,
  mergeWorktreesForHost,
  repoHasExactlyOneExecutionHostOwner,
  toVisibleWorktrees,
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from './worktree-host-ownership'
import {
  hasBranchScopedHostedReviewContext,
  sanitizeHostedReviewLinksForBranchClears
} from '../metadata/hosted-review-link-mutation'
import { isCurrentDetectedWorktreeRefresh } from './detected-worktree-refresh-admission'
import { buildWorktreePurgeState } from '../teardown/worktree-purge-state'
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

export function mergeFetchedWorktrees(
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
