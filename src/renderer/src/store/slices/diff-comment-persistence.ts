import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoIdFromWorktreeId } from './worktree-helpers'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  diffCommentFloorKey,
  diffCommentRowNotes,
  findDiffCommentRows,
  readQueuedDiffComments,
  type DiffCommentTwin
} from '../worktree-diff-comments-selector'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace
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

export type DiffCommentMutation = {
  previous: DiffComment[] | undefined
  next: DiffComment[]
  folderExecutionHostId?: ReturnType<typeof getExecutionHostIdForFolderWorkspace>
  /** The identity of the rows changed, so a queued save never reads a copy listed later. */
  twin?: DiffCommentTwin
  /** The rows' own host, whenever they stamp one; the write names it. */
  writeHostId?: ExecutionHostId
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
  const folderExecutionHostId = mutation.folderExecutionHostId
  const queueKey = persistQueueKey(worktreeId, folderExecutionHostId)
  // Continue the floor that produced this list across twin appearance/removal; new chains take the copy’s own floor.
  const floorKey =
    [...(floorKeysByQueue.get(queueKey) ?? [])].find(
      (key) => lastMutationNextByQueue.get(key) === mutation.previous
    ) ?? diffCommentFloorKey(queueKey, mutation.twin)
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
        stateList = folderWorkspace?.diffComments
        await writeDiffCommentsToHost(
          state,
          worktreeId,
          (stateList ?? []).map(normalizeDiffComment),
          folderExecutionHostId
        )
      } else {
        const state = get()
        const { twin, writeHostId } = mutation
        const queued = readQueuedDiffComments(state, worktreeId, {
          twin,
          hostId: writeHostId,
          latest: lastMutationNextByQueue.get(floorKey)
        })
        // Why: the copy these notes were made on is gone or now unnamed; never send another's list.
        if (!queued) {
          throw new Error('The workspace copy is gone; review notes were not saved.')
        }
        stateList = queued.list
        await writeDiffCommentsToHost(
          state,
          worktreeId,
          (stateList ?? []).map(normalizeDiffComment),
          undefined,
          writeHostId
        )
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
  worktreeId: string,
  mutate: (existing: DiffComment[]) => DiffComment[] | null,
  commentIds?: Iterable<string>
): DiffCommentMutation | null {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let previous: DiffComment[] | undefined
  let next: DiffComment[] | null = null
  let folderExecutionHostId: ReturnType<typeof getExecutionHostIdForFolderWorkspace> | undefined
  let twin: Pick<DiffCommentMutation, 'twin' | 'writeHostId'> = {}
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const target = findFolderWorkspaceOwner(s, scope.folderWorkspaceId)
      if (!target) {
        return s
      }
      folderExecutionHostId = getExecutionHostIdForFolderWorkspace(s, scope.folderWorkspaceId)
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
    const repoList = s.worktreesByRepo[repoId]
    const found = findDiffCommentRows(
      s,
      worktreeId,
      commentIds ? { commentIds: new Set(commentIds) } : {}
    )
    if (!repoList || !found) {
      return s
    }
    twin = {
      ...(found.twin ? { twin: found.twin } : {}),
      ...(found.hostId ? { writeHostId: found.hostId } : {})
    }
    previous = diffCommentRowNotes(found)
    const computed = mutate(previous ?? [])
    if (computed === null) {
      return s
    }
    next = computed
    const nextList: Worktree[] = repoList.map((w) =>
      found.worktrees.includes(w) ? { ...w, diffComments: computed } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
  if (next === null) {
    return null
  }
  return { previous, next, folderExecutionHostId, ...twin }
}

// Why: on IPC-write failure, roll back optimistic state so the renderer matches disk (identity-guarded below).
function rollback(
  set: Parameters<StateCreator<AppState>>[0],
  worktreeId: string,
  previous: DiffComment[] | undefined,
  { next: expectedCurrent, folderExecutionHostId }: DiffCommentMutation
): void {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const target = findFolderWorkspaceOwner(s, scope.folderWorkspaceId, folderExecutionHostId)
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
    const targets = repoList.filter(
      (w) => w.id === worktreeId && w.diffComments === expectedCurrent
    )
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
