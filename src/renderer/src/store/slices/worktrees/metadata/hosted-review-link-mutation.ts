import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { WorktreeSlice } from '../../worktree-helpers'
import { applyWorktreeUpdates } from '../../worktree-helpers'
import { branchName } from '@/lib/git-utils'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getLinkedGitHubPRRepository } from '../../../github/linked-pr-repository'
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

/** What one branch-switch clear wrote; replayed by re-clears, persistence and tombstones. */
export type HostedReviewLinkClear = Partial<Pick<WorktreeMeta, HostedReviewLinkKey | 'pushTarget'>>

const CLEARED_PUSH_TARGET_UPDATES: HostedReviewLinkClear = { pushTarget: undefined }

export const hostedReviewLinkMutationGenerationByWorktreeId = new Map<string, number>()
export const hostedReviewLinkClearTombstonesByWorktreeId = new Map<
  string,
  {
    branch: string
    branchIdentity: string
    generation: number
    head?: string
    cleared: HostedReviewLinkClear
  }
>()
export const hostedReviewLinkWorktreeIdAliases = new Map<string, string>()

export function hasHostedReviewLinks(worktree: Worktree): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => worktree[key] != null)
}

/** What a branch switch clears; a PR linked from another repository names no branch of this worktree. */
export function getBranchSwitchHostedReviewClear(
  worktree: Worktree,
  repo?: Repo
): HostedReviewLinkClear | null {
  const hasPushTarget = worktree.pushTarget !== undefined
  if (getLinkedGitHubPRRepository(worktree, repo)) {
    return hasPushTarget ? CLEARED_PUSH_TARGET_UPDATES : null
  }
  return hasHostedReviewLinks(worktree) || hasPushTarget ? CLEARED_HOSTED_REVIEW_LINK_UPDATES : null
}

export function hasBranchScopedHostedReviewContext(worktree: Worktree, repo?: Repo): boolean {
  return getBranchSwitchHostedReviewClear(worktree, repo) !== null
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

export function hostedReviewLinksAreCleared(
  worktree: Partial<Pick<Worktree, HostedReviewLinkKey | 'pushTarget'>>,
  cleared: HostedReviewLinkClear = CLEARED_HOSTED_REVIEW_LINK_UPDATES
): boolean {
  return (
    HOSTED_REVIEW_LINK_KEYS.every((key) => !(key in cleared) || worktree[key] == null) &&
    !worktree.pushTarget
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

export function canonicalHostedReviewBranchIdentity(branch: string): string {
  return branchName(branch).trim()
}

export function rememberHostedReviewLinkClear(
  worktreeId: string,
  branch: string,
  generation: number,
  head?: string,
  cleared: HostedReviewLinkClear = CLEARED_HOSTED_REVIEW_LINK_UPDATES
): void {
  hostedReviewLinkClearTombstonesByWorktreeId.set(worktreeId, {
    branch,
    branchIdentity: canonicalHostedReviewBranchIdentity(branch),
    generation,
    head,
    cleared
  })
}

export function sanitizeHostedReviewLinksForBranchClear<
  T extends Pick<Worktree, 'id' | 'branch'> &
    Partial<Pick<Worktree, HostedReviewLinkKey | 'pushTarget' | 'head'>>
>(worktree: T, currentWorktrees?: readonly T[]): T {
  const hostedReviewWorktreeId = resolveHostedReviewLinkWorktreeId(worktree.id)
  const tombstone = hostedReviewLinkClearTombstonesByWorktreeId.get(hostedReviewWorktreeId)
  if (
    !tombstone ||
    tombstone.generation !== getHostedReviewLinkMutationGeneration(hostedReviewWorktreeId) ||
    hostedReviewLinksAreCleared(worktree, tombstone.cleared)
  ) {
    return worktree
  }
  const current = currentWorktrees?.find(
    (entry) =>
      entry.id === worktree.id ||
      resolveHostedReviewLinkWorktreeId(entry.id) === hostedReviewWorktreeId
  )
  const currentClean =
    current && hostedReviewLinksAreCleared(current, tombstone.cleared) ? current : null
  const guardBranch = currentClean ? currentClean.branch : tombstone.branch
  const guardHead = currentClean ? currentClean.head : tombstone.head
  return {
    ...worktree,
    branch: guardBranch,
    ...(guardHead !== undefined ? { head: guardHead } : {}),
    ...tombstone.cleared
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
  worktreeId: string,
  cleared: HostedReviewLinkClear = CLEARED_HOSTED_REVIEW_LINK_UPDATES
): void {
  set((s) => {
    const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, cleared)
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      cleared
    )
    if (
      nextWorktrees === s.worktreesByRepo &&
      nextDetectedWorktrees === s.detectedWorktreesByRepo
    ) {
      return s
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
