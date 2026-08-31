import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { WorktreeSlice } from '../../worktree-helpers'
import { applyWorktreeUpdates } from '../../worktree-helpers'
import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import { branchName } from '@/lib/git-utils'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { applyDetectedWorktreeUpdates } from '../listing/detected-worktree-meta'
import type {
  HostedReviewLinkKey,
  RuntimeWorktreeMetaUpdates
} from '../listing/worktree-slice-types'

export const HOSTED_REVIEW_LINK_KEYS: readonly HostedReviewLinkKey[] = [
  'linkedPR',
  'linkedGitLabMR',
  'linkedBitbucketPR',
  'linkedAzureDevOpsPR',
  'linkedGiteaPR'
]

export const CLEARED_HOSTED_REVIEW_LINK_UPDATES: Pick<
  WorktreeMeta,
  HostedReviewLinkKey | 'pushTarget'
> = {
  linkedPR: null,
  linkedGitLabMR: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null,
  pushTarget: undefined
}

export const hostedReviewLinkMutationGenerationByWorktreeId = new Map<string, number>()
export const hostedReviewLinkClearTombstonesByWorktreeId = new Map<
  string,
  { branch: string; branchIdentity: string; generation: number; head?: string }
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

export function bumpHostedReviewLinkMutationGeneration(worktreeId: string): void {
  hostedReviewLinkMutationGenerationByWorktreeId.set(
    worktreeId,
    getHostedReviewLinkMutationGeneration(worktreeId) + 1
  )
  hostedReviewLinkClearTombstonesByWorktreeId.delete(worktreeId)
  pruneHostedReviewLinkWorktreeAliasesForId(worktreeId)
}

export function pruneHostedReviewLinkMutationGenerations(worktreeIds: Iterable<string>): void {
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

export function hostedReviewLinksAreCleared(worktree: Worktree): boolean {
  return HOSTED_REVIEW_LINK_KEYS.every((key) => worktree[key] == null) && !worktree.pushTarget
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

export function canonicalHostedReviewBranchIdentity(branch: string): string {
  return branchName(branch).trim()
}

export function rememberHostedReviewLinkClear(
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

export function sanitizeHostedReviewLinksForBranchClear<
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

export function sanitizeHostedReviewLinksForBranchClears<
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

export function applyHostedReviewLinkClear(
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

export function getPositiveHostedReviewLinkUpdateKey(
  updates: Partial<WorktreeMeta>
): HostedReviewLinkKey | null {
  for (const key of HOSTED_REVIEW_LINK_KEYS) {
    if (isPositiveHostedReviewNumber(updates[key])) {
      return key
    }
  }
  return null
}

export function clearOlderHostedReviewLinksForReplacement(
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

export function getHostedReviewLinkForMetaRefresh(
  updates: Partial<WorktreeMeta>,
  existingWorktree: Worktree | undefined,
  key: HostedReviewLinkKey
): number | null {
  return Object.hasOwn(updates, key) ? (updates[key] ?? null) : (existingWorktree?.[key] ?? null)
}

export function hasExplicitPushTargetClear(updates: Partial<WorktreeMeta>): boolean {
  return Object.hasOwn(updates, 'pushTarget') && updates.pushTarget === undefined
}

export function encodePushTargetClearForRuntimeRpc(
  updates: Partial<WorktreeMeta>
): RuntimeWorktreeMetaUpdates {
  if (!hasExplicitPushTargetClear(updates)) {
    return updates
  }
  // Why: remote runtime RPC is JSON-shaped and drops undefined, so null is the wire signal for clearing persisted pushTarget metadata.
  return { ...updates, pushTarget: null }
}
