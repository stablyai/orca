import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { WorktreeSlice } from '../worktree-slice-contract'
import {
  clearCopyReviewLinks,
  deleteCopyTombstones,
  dropCopyTombstone,
  moveCopyTombstones,
  reviewClearTombstoneKey,
  type WorktreeCopyClear,
  worktreeCopyOwnerKey
} from './worktree-copy-review-clear'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { applyDetectedWorktreeUpdates } from '../listing/detected-worktree-meta'
import type { HostedReviewLinkKey } from '../listing/worktree-slice-types'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  HOSTED_REVIEW_LINK_KEYS,
  canonicalHostedReviewBranchIdentity
} from '../../../../../../shared/worktree/hosted-review-links'
import { deleteDetachedOwners, moveDetachedOwners } from './detached-hosted-review-owners'
import type {
  HostedReviewClearUpdates,
  HostedReviewContext
} from '../../../../../../shared/worktree/hosted-review-branch-ownership'

export {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  HOSTED_REVIEW_LINK_KEYS,
  canonicalHostedReviewBranchIdentity
}

export const hostedReviewLinkMutationGenerationByWorktreeId = new Map<string, number>()
export const hostedReviewLinkClearTombstonesByCopy = new Map<
  string,
  {
    branch: string
    branchIdentity: string
    generation: number
    head?: string
    /** The guarded copy's stamped {@link worktreeCopyOwnerKey}; part of the map key too. */
    owner: string
    /** Its key before a listing stamped it; a relink of the unstamped row still matches. */
    rowOwner: string
    updates: HostedReviewClearUpdates
  }
>()
export const hostedReviewLinkWorktreeIdAliases = new Map<string, string>()

export function hasHostedReviewLinks(worktree: Worktree): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => worktree[key] != null)
}

export function hasBranchScopedHostedReviewContext(worktree: Worktree): boolean {
  return hasHostedReviewLinks(worktree) || worktree.pushTarget !== undefined
}

export function hasHostedReviewLinkUpdates(updates: Partial<WorktreeMeta>): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => key in updates) || 'pushTarget' in updates
}

export function hasChangedHostedReviewLinkUpdates(
  updates: Partial<WorktreeMeta>,
  worktree: Worktree
): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => key in updates && updates[key] !== worktree[key])
}

export function getHostedReviewLinkMutationGeneration(worktreeId: string): number {
  return hostedReviewLinkMutationGenerationByWorktreeId.get(worktreeId) ?? 0
}

/** A manual relink; naming the relinked copy keeps a same-path twin's own clear guard. */
export function bumpHostedReviewLinkMutationGeneration(
  worktreeId: string,
  relinkedCopy?: Partial<Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>>
): void {
  const generation = getHostedReviewLinkMutationGeneration(worktreeId) + 1
  hostedReviewLinkMutationGenerationByWorktreeId.set(worktreeId, generation)
  const owner = relinkedCopy ? worktreeCopyOwnerKey(relinkedCopy) : undefined
  if (owner === undefined) {
    deleteCopyTombstones(hostedReviewLinkClearTombstonesByCopy, worktreeId)
    pruneHostedReviewLinkWorktreeAliasesForId(worktreeId)
    return
  }
  const siblingGuarded = dropCopyTombstone(
    hostedReviewLinkClearTombstonesByCopy,
    worktreeId,
    owner,
    generation
  )
  if (!siblingGuarded) {
    pruneHostedReviewLinkWorktreeAliasesForId(worktreeId)
  }
}

export function pruneHostedReviewLinkMutationGenerations(worktreeIds: Iterable<string>): void {
  for (const worktreeId of worktreeIds) {
    hostedReviewLinkMutationGenerationByWorktreeId.delete(worktreeId)
    deleteCopyTombstones(hostedReviewLinkClearTombstonesByCopy, worktreeId)
    deleteDetachedOwners(worktreeId)
    hostedReviewLinkWorktreeIdAliases.delete(worktreeId)
    for (const [oldWorktreeId, newWorktreeId] of hostedReviewLinkWorktreeIdAliases) {
      if (newWorktreeId === worktreeId) {
        hostedReviewLinkWorktreeIdAliases.delete(oldWorktreeId)
      }
    }
  }
}

export function resolveHostedReviewLinkWorktreeId(worktreeId: string): string {
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

export function pruneHostedReviewLinkWorktreeAliasesForId(worktreeId: string): void {
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

export function migrateHostedReviewLinkMutationGeneration(
  oldWorktreeId: string,
  newWorktreeId: string
): void {
  moveDetachedOwners(oldWorktreeId, newWorktreeId)
  const hasTombstone = moveCopyTombstones(
    hostedReviewLinkClearTombstonesByCopy,
    oldWorktreeId,
    newWorktreeId
  )
  for (const [alias, target] of hostedReviewLinkWorktreeIdAliases) {
    if (target === oldWorktreeId) {
      if (hasTombstone) {
        hostedReviewLinkWorktreeIdAliases.set(alias, newWorktreeId)
      } else {
        hostedReviewLinkWorktreeIdAliases.delete(alias)
      }
    }
  }
  const hasGeneration = hostedReviewLinkMutationGenerationByWorktreeId.has(oldWorktreeId)
  if (hasTombstone) {
    hostedReviewLinkWorktreeIdAliases.set(oldWorktreeId, newWorktreeId)
  }
  if (hasGeneration) {
    hostedReviewLinkMutationGenerationByWorktreeId.set(
      newWorktreeId,
      getHostedReviewLinkMutationGeneration(oldWorktreeId)
    )
    hostedReviewLinkMutationGenerationByWorktreeId.delete(oldWorktreeId)
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
  hostedReviewLinkClearTombstonesByCopy.clear()
  hostedReviewLinkWorktreeIdAliases.clear()
  deleteDetachedOwners()
}

export function hostedReviewLinksAreCleared(
  worktree: HostedReviewContext,
  updates: HostedReviewClearUpdates = CLEARED_HOSTED_REVIEW_LINK_UPDATES
): boolean {
  return (
    HOSTED_REVIEW_LINK_KEYS.every((key) => !(key in updates) || worktree[key] == null) &&
    (!('pushTarget' in updates) || worktree.pushTarget === undefined)
  )
}

export function getHostedReviewLinkUpdates(
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

export function rememberHostedReviewLinkClear(
  worktreeId: string,
  branch: string,
  generation: number,
  head: string | undefined,
  copy: Pick<WorktreeCopyClear, 'owner' | 'rowOwner'>,
  updates: HostedReviewClearUpdates = CLEARED_HOSTED_REVIEW_LINK_UPDATES
): void {
  hostedReviewLinkClearTombstonesByCopy.set(reviewClearTombstoneKey(worktreeId, copy.owner), {
    branch,
    branchIdentity: canonicalHostedReviewBranchIdentity(branch),
    generation,
    head,
    owner: copy.owner,
    rowOwner: copy.rowOwner,
    updates
  })
}

export function sanitizeHostedReviewLinksForBranchClear<
  T extends Pick<Worktree, 'id' | 'branch'> &
    Partial<
      Pick<
        Worktree,
        | HostedReviewLinkKey
        | 'pushTarget'
        | 'head'
        | 'linkedItems'
        | 'hostId'
        | 'runtimeOwnerEnvironmentId'
      >
    >
>(worktree: T, currentWorktrees?: readonly T[]): T {
  const hostedReviewWorktreeId = resolveHostedReviewLinkWorktreeId(worktree.id)
  // Why the copy key only: a bare-id guard would also rewrite a same-path twin that arrives later.
  const tombstone = hostedReviewLinkClearTombstonesByCopy.get(
    reviewClearTombstoneKey(hostedReviewWorktreeId, worktreeCopyOwnerKey(worktree))
  )
  if (
    !tombstone ||
    tombstone.generation !== getHostedReviewLinkMutationGeneration(hostedReviewWorktreeId) ||
    hostedReviewLinksAreCleared(worktree, tombstone.updates)
  ) {
    return worktree
  }
  const current = currentWorktrees?.find(
    (entry) =>
      worktreeCopyOwnerKey(entry) === tombstone.owner &&
      (entry.id === worktree.id ||
        resolveHostedReviewLinkWorktreeId(entry.id) === hostedReviewWorktreeId)
  )
  const currentClean =
    current && hostedReviewLinksAreCleared(current, tombstone.updates) ? current : null
  const guardBranch = currentClean ? currentClean.branch : tombstone.branch
  const guardHead = currentClean ? currentClean.head : tombstone.head
  return {
    ...worktree,
    branch: guardBranch,
    ...(guardHead !== undefined ? { head: guardHead } : {}),
    ...normalizeWorkspaceAttachmentUpdate(worktree, tombstone.updates)
  }
}

export function sanitizeHostedReviewLinksForBranchClears<
  T extends Pick<Worktree, 'id' | 'branch'> &
    Partial<Pick<Worktree, HostedReviewLinkKey | 'pushTarget' | 'head' | 'linkedItems'>>
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

export function applyHostedReviewLinkClear(
  set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  worktreeId: string,
  copy: WorktreeCopyClear,
  updates: HostedReviewClearUpdates = CLEARED_HOSTED_REVIEW_LINK_UPDATES
): void {
  set((s) => {
    const byRepo = s.worktreesByRepo
    const nextWorktrees = clearCopyReviewLinks(byRepo, worktreeId, copy, updates)
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      updates,
      copy.hostId
    )
    if (nextWorktrees === byRepo && nextDetectedWorktrees === s.detectedWorktreesByRepo) {
      return s
    }
    return {
      ...(nextWorktrees !== byRepo
        ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
        : {}),
      ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
        ? { detectedWorktreesByRepo: nextDetectedWorktrees }
        : {})
    }
  })
}
