import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoIdFromWorktreeId } from './worktree-helpers'
import { findCopyRows } from '../worktree-diff-comments-selector'
import { diffCommentOwnerKey, type DiffCommentOwner } from '../diff-comment-owner'
import {
  findFolderWorkspaceOwner,
  type getExecutionHostIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { writeDiffCommentsToHost } from './diff-comment-host-write'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export function normalizeDiffComment(comment: DiffComment): DiffComment {
  const rawSource = (comment as { source?: unknown }).source
  const source = rawSource === 'markdown' || rawSource === 'diff' ? rawSource : undefined
  const rawStartLine = (comment as { startLine?: unknown }).startLine
  const startLine =
    Number.isInteger(rawStartLine) &&
    typeof rawStartLine === 'number' &&
    rawStartLine >= 1 &&
    rawStartLine <= comment.lineNumber
      ? rawStartLine
      : undefined
  const rawSelectedText = (comment as { selectedText?: unknown }).selectedText
  const selectedText =
    typeof rawSelectedText === 'string' && rawSelectedText.trim().length > 0
      ? rawSelectedText.trim()
      : undefined
  const rawSentAt = (comment as { sentAt?: unknown }).sentAt
  const sentAt =
    typeof rawSentAt === 'number' && Number.isFinite(rawSentAt) && rawSentAt > 0
      ? rawSentAt
      : undefined

  return {
    ...comment,
    ...(source !== undefined ? { source } : {}),
    ...(source === undefined ? { source: undefined } : {}),
    ...(selectedText !== undefined ? { selectedText } : {}),
    ...(selectedText === undefined ? { selectedText: undefined } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(startLine === undefined ? { startLine: undefined } : {}),
    ...(sentAt !== undefined ? { sentAt } : {}),
    ...(sentAt === undefined ? { sentAt: undefined } : {})
  }
}

// Why: IPC writes aren't ordered, so serialize per worktree to stop an older snapshot from overwriting a newer one on disk.
const persistQueueByWorktree = new Map<string, Promise<void>>()

// Why: twins share a queue (one id), but each keeps its own rollback floor and mutation chain.
const floorKeysByQueue = new Map<string, Set<string>>()

// Why: rollback must converge to what actually reached disk; in a burst of failed writes each mutation's own predecessor is stale.
const lastPersistedByQueue = new Map<string, DiffComment[] | undefined>()

// Why: the floor is only valid across an unbroken mutation chain; this is how an out-of-band replacement mid-burst is detected.
const lastMutationNextByQueue = new Map<string, DiffComment[]>()

// Why: bumped on every re-seed, so an in-flight write can tell whether the floor it captured is still the current one.
const floorSeedEpochByQueue = new Map<string, number>()

/** One change to one copy's notes; the owner alone says which rows it reads, writes and rolls back. */
export type DiffCommentMutation = {
  owner: DiffCommentOwner
  previous: DiffComment[] | undefined
  next: DiffComment[]
}

function folderExecutionHostIdOf(
  owner: DiffCommentOwner
): ReturnType<typeof getExecutionHostIdForFolderWorkspace> | undefined {
  return owner.kind === 'folder' ? owner.executionHostId : undefined
}

// Why: one key for the queue and both bookkeeping maps, so they can never drift apart.
function persistQueueKey(
  worktreeId: string,
  folderExecutionHostId?: ReturnType<typeof getExecutionHostIdForFolderWorkspace>
): string {
  return folderExecutionHostId ? `${folderExecutionHostId}\0${worktreeId}` : worktreeId
}

// Why: chain each write onto the prior promise so writes land in call order; both then handlers keep the chain alive past a failure.
// Why: queued work reads the latest list at dequeue time, and the returned promise settles for THIS write.
// Why: this promise rejects only after this write's rollback has been applied — callers must not roll back themselves.
export function enqueueDiffCommentPersist(
  set: Parameters<StateCreator<AppState>>[0],
  worktreeId: string,
  get: () => AppState,
  mutation: DiffCommentMutation
): Promise<void> {
  const folderExecutionHostId = folderExecutionHostIdOf(mutation.owner)
  const queueKey = persistQueueKey(worktreeId, folderExecutionHostId)
  // Copies sharing an id share one queue; each keeps its own floor, so a floor never restores another copy.
  const floorKey = diffCommentOwnerKey(mutation.owner)
  floorKeysByQueue.set(queueKey, (floorKeysByQueue.get(queueKey) ?? new Set()).add(floorKey))
  const prior = persistQueueByWorktree.get(queueKey) ?? Promise.resolve()
  // Why: an idle queue means disk still holds the pre-mutation list, so that list is this burst's rollback floor.
  // If previous differs from last mutation’s next, hydration/refresh/push broke the chain; reseed floor before enqueue makes has true.
  const chainBroken = lastMutationNextByQueue.get(floorKey) !== mutation.previous
  if (
    !persistQueueByWorktree.has(queueKey) ||
    !lastMutationNextByQueue.has(floorKey) ||
    chainBroken
  ) {
    lastPersistedByQueue.set(floorKey, mutation.previous)
    floorSeedEpochByQueue.set(floorKey, (floorSeedEpochByQueue.get(floorKey) ?? 0) + 1)
  }
  lastMutationNextByQueue.set(floorKey, mutation.next)
  const run = async (): Promise<void> => {
    // Capture epoch at dequeue with coalesced stateList; enqueue-time epochs would reject floors spanning chain breaks.
    const seedEpoch = floorSeedEpochByQueue.get(floorKey)
    // Retain state-side array rather than disk-normalized clone so rollback preserves getDiffComments identity.
    let stateList: DiffComment[] | undefined
    try {
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        const state = get()
        const folderWorkspace = findFolderWorkspaceOwner(
          state,
          scope.folderWorkspaceId,
          folderExecutionHostId
        )
        if (!folderWorkspace) {
          throw new Error('The workspace copy is gone; review notes were not saved.')
        }
        stateList = folderWorkspace.diffComments
        await writeDiffCommentsToHost(mutation.owner, (stateList ?? []).map(normalizeDiffComment))
      } else if (mutation.owner.kind === 'worktree') {
        const rows = findCopyRows(get(), worktreeId, mutation.owner.authority)
        // Why: the copy these notes were made on is gone; never send another's list.
        if (rows.length === 0) {
          throw new Error('The workspace copy is gone; review notes were not saved.')
        }
        stateList = rows.at(-1)?.diffComments
        await writeDiffCommentsToHost(mutation.owner, (stateList ?? []).map(normalizeDiffComment))
      }
    } catch (err) {
      // Why: converge to what actually landed; rollback's identity guard no-ops when a later mutation owns the array.
      // Why: `has()`, not `get() ?? …` — an absent entry and a legitimately-`undefined` floor are different things.
      const floor = lastPersistedByQueue.has(floorKey)
        ? lastPersistedByQueue.get(floorKey)
        : mutation.previous
      rollback(set, worktreeId, floor, mutation)
      throw err
    }
    // Out-of-band replacement during await reseeded floor; never restore the older captured list as floor.
    if (floorSeedEpochByQueue.get(floorKey) === seedEpoch) {
      lastPersistedByQueue.set(floorKey, stateList)
    }
  }
  const next = prior.then(run, run)
  persistQueueByWorktree.set(queueKey, next)
  // Why: clear the queue entry only if still the tail, so later enqueues chain onto the real in-flight promise.
  // Why: then(cleanup, cleanup) not finally, so a rejection is consumed here rather than re-thrown as unhandledRejection.
  const cleanup = (): void => {
    if (persistQueueByWorktree.get(queueKey) === next) {
      persistQueueByWorktree.delete(queueKey)
      // Why: tail-guarded only; a mid-burst delete would strand the remaining writes of the burst without a floor.
      for (const key of floorKeysByQueue.get(queueKey) ?? []) {
        lastPersistedByQueue.delete(key)
        lastMutationNextByQueue.delete(key)
        floorSeedEpochByQueue.delete(key)
      }
      floorKeysByQueue.delete(queueKey)
    }
  }
  next.then(cleanup, cleanup)
  return next
}

// Why: derive the next list inside the `set` updater so concurrent writes can't clobber each other via a stale closure.
export function mutateDiffComments(
  set: Parameters<StateCreator<AppState>>[0],
  owner: DiffCommentOwner,
  mutate: (existing: DiffComment[]) => DiffComment[] | null
): DiffCommentMutation | null {
  const worktreeId = owner.worktreeId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let previous: DiffComment[] | undefined
  let next: DiffComment[] | null = null
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      if (owner.kind !== 'folder') {
        return s
      }
      const target = findFolderWorkspaceOwner(s, scope.folderWorkspaceId, owner.executionHostId)
      if (!target) {
        return s
      }
      previous = target.diffComments
      const computed = mutate(previous ?? [])
      if (computed === null) {
        return s
      }
      next = computed
      return {
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace === target ? { ...workspace, diffComments: computed } : workspace
        )
      }
    }
    if (owner.kind !== 'worktree') {
      return s
    }
    const repoList = s.worktreesByRepo[repoId]
    const rows = findCopyRows(s, worktreeId, owner.authority)
    if (!repoList || rows.length === 0) {
      return s
    }
    previous = rows.at(-1)?.diffComments
    const computed = mutate(previous ?? [])
    if (computed === null) {
      return s
    }
    next = computed
    const nextList: Worktree[] = repoList.map((w) =>
      rows.includes(w) ? { ...w, diffComments: computed } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
  if (next === null) {
    return null
  }
  return { owner, previous, next }
}

// Why: on IPC-write failure, roll back optimistic state so the renderer matches disk (identity-guarded below).
function rollback(
  set: Parameters<StateCreator<AppState>>[0],
  worktreeId: string,
  previous: DiffComment[] | undefined,
  { next: expectedCurrent, owner }: DiffCommentMutation
): void {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      if (owner.kind !== 'folder') {
        return s
      }
      const target = findFolderWorkspaceOwner(s, scope.folderWorkspaceId, owner.executionHostId)
      if (!target || target.diffComments !== expectedCurrent) {
        return s
      }
      return {
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace === target ? { ...workspace, diffComments: previous } : workspace
        )
      }
    }
    const repoList = s.worktreesByRepo[repoId]
    if (!repoList) {
      return s
    }
    // Rollback only rows still holding this mutation’s array; later mutations and untouched twins must survive.
    const targets =
      owner.kind === 'worktree'
        ? findCopyRows(s, worktreeId, owner.authority).filter(
            (w) => w.diffComments === expectedCurrent
          )
        : []
    // Removed worktrees return before remapping to avoid pointless identity churn/notifications.
    if (targets.length === 0) {
      return s
    }
    const nextList: Worktree[] = repoList.map((w) =>
      targets.includes(w) ? { ...w, diffComments: previous } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
}
