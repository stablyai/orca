/* eslint-disable max-lines -- Why: keeps note mutation, rollback, persistence ordering, and sent-state transitions under shared queue/rollback invariants. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { findWorktreeById, getRepoIdFromWorktreeId } from './worktree-helpers'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export type DiffCommentsSlice = {
  getDiffComments: (worktreeId: string | null | undefined) => DiffComment[]
  addDiffComment: (input: Omit<DiffComment, 'id' | 'createdAt'>) => Promise<DiffComment | null>
  updateDiffComment: (worktreeId: string, commentId: string, body: string) => Promise<boolean>
  clearDeliveredDiffComments: (
    worktreeId: string,
    comments: readonly DiffCommentDeliverySnapshot[]
  ) => Promise<boolean>
  markDiffCommentsSent: (
    worktreeId: string,
    commentIds: readonly string[],
    sentAt?: number
  ) => Promise<boolean>
  deleteDiffComment: (worktreeId: string, commentId: string) => Promise<void>
  clearDiffComments: (worktreeId: string) => Promise<boolean>
  clearDiffCommentsForFile: (worktreeId: string, filePath: string) => Promise<boolean>
}

export type DiffCommentDeliverySnapshot = Pick<
  DiffComment,
  'body' | 'filePath' | 'id' | 'lineNumber' | 'selectedText' | 'source' | 'startLine'
>

function generateId(): string {
  return createBrowserUuid()
}

function normalizeDiffComment(comment: DiffComment): DiffComment {
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

function deliverySnapshotMatches(
  comment: DiffComment,
  snapshot: DiffCommentDeliverySnapshot
): boolean {
  return (
    comment.id === snapshot.id &&
    comment.body === snapshot.body &&
    comment.filePath === snapshot.filePath &&
    comment.lineNumber === snapshot.lineNumber &&
    comment.startLine === snapshot.startLine &&
    comment.selectedText === snapshot.selectedText &&
    comment.source === snapshot.source
  )
}

// Why: a frozen shared sentinel avoids selector re-renders and mutation.
const EMPTY_COMMENTS: readonly DiffComment[] = Object.freeze([])

async function persist(
  state: AppState,
  settings: AppState['settings'],
  worktreeId: string,
  diffComments: DiffComment[],
  folderExecutionHostId?: ReturnType<typeof getExecutionHostIdForFolderWorkspace>
): Promise<void> {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const executionHostId =
      folderExecutionHostId ?? getExecutionHostIdForFolderWorkspace(state, scope.folderWorkspaceId)
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      executionHostId
    )
    const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId: runtimeEnvironmentId })
    const updated =
      target.kind === 'local'
        ? await window.api.folderWorkspaces.update({
            folderWorkspaceId: scope.folderWorkspaceId,
            updates: { diffComments }
          })
        : (
            await callRuntimeRpc<{ folderWorkspace: FolderWorkspace | null }>(
              target,
              'folderWorkspace.update',
              { folderWorkspaceId: scope.folderWorkspaceId, updates: { diffComments } },
              { timeoutMs: 15_000 }
            )
          ).folderWorkspace
    if (!updated?.diffComments) {
      throw new Error('Failed to persist folder workspace review notes')
    }
    return
  }
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    await window.api.worktrees.updateMeta({
      worktreeId,
      updates: { diffComments }
    })
    return
  }
  await callRuntimeRpc(
    target,
    'worktree.set',
    { worktree: toRuntimeWorktreeSelector(worktreeId), diffComments },
    { timeoutMs: 15_000 }
  )
}

function settingsForWorktreeOwner(state: AppState, worktreeId: string): AppState['settings'] {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: runtimeEnvironmentId } as AppState['settings'])
}

// Why: IPC writes aren't ordered, so serialize per worktree to stop an older snapshot from overwriting a newer one on disk.
const persistQueueByWorktree = new Map<string, Promise<void>>()

// Why: rollback must converge to what actually reached disk; in a burst of failed writes each mutation's own predecessor is stale.
const lastPersistedByQueue = new Map<string, DiffComment[] | undefined>()

// Why: the floor is only valid across an unbroken mutation chain; this is how an out-of-band replacement mid-burst is detected.
const lastMutationNextByQueue = new Map<string, DiffComment[]>()

// Why: bumped on every re-seed, so an in-flight write can tell whether the floor it captured is still the current one.
const floorSeedEpochByQueue = new Map<string, number>()

type CommentMutation = {
  previous: DiffComment[] | undefined
  next: DiffComment[]
  folderExecutionHostId?: ReturnType<typeof getExecutionHostIdForFolderWorkspace>
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
function enqueuePersist(
  set: Parameters<StateCreator<AppState, [], [], DiffCommentsSlice>>[0],
  worktreeId: string,
  get: () => AppState,
  mutation: CommentMutation
): Promise<void> {
  const folderExecutionHostId = mutation.folderExecutionHostId
  const queueKey = persistQueueKey(worktreeId, folderExecutionHostId)
  const prior = persistQueueByWorktree.get(queueKey) ?? Promise.resolve()
  // Why: an idle queue means disk still holds the pre-mutation list, so that list is this burst's rollback floor.
  // Why: a `previous` that isn't the last mutation's `next` means something outside the mutators replaced the list
  //      (hydration, folderWorkspaces refresh, remote push), so the old floor predates that state and must be re-seeded.
  // Why: seed before the queue entry below, or `has` is always true and the floor is never seeded.
  const chainBroken = lastMutationNextByQueue.get(queueKey) !== mutation.previous
  if (!persistQueueByWorktree.has(queueKey) || chainBroken) {
    lastPersistedByQueue.set(queueKey, mutation.previous)
    floorSeedEpochByQueue.set(queueKey, (floorSeedEpochByQueue.get(queueKey) ?? 0) + 1)
  }
  lastMutationNextByQueue.set(queueKey, mutation.next)
  const run = async (): Promise<void> => {
    // Why: capture at dequeue time, alongside `stateList` — an epoch read at enqueue time would bar every write
    //      that straddles a chain break from recording a floor its coalesced payload already carries.
    const seedEpoch = floorSeedEpochByQueue.get(queueKey)
    // Why: the state-side array, not the normalized copy sent to disk — restoring the same instance keeps
    //      `getDiffComments` identity stable instead of churning selectors.
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
        await persist(
          state,
          state.settings,
          worktreeId,
          (stateList ?? []).map(normalizeDiffComment),
          folderExecutionHostId
        )
      } else {
        const repoId = getRepoIdFromWorktreeId(worktreeId)
        const target = get().worktreesByRepo[repoId]?.find((w) => w.id === worktreeId)
        stateList = target?.diffComments
        const state = get()
        await persist(
          state,
          settingsForWorktreeOwner(state, worktreeId),
          worktreeId,
          (stateList ?? []).map(normalizeDiffComment)
        )
      }
    } catch (err) {
      // Why: converge to what actually landed; rollback's identity guard no-ops when a later mutation owns the array.
      // Why: `has()`, not `get() ?? …` — an absent entry and a legitimately-`undefined` floor are different things.
      const floor = lastPersistedByQueue.has(queueKey)
        ? lastPersistedByQueue.get(queueKey)
        : mutation.previous
      rollback(set, worktreeId, floor, mutation.next, folderExecutionHostId)
      throw err
    }
    // Why: a chain break re-seeded the floor to an out-of-band replacement while this write was awaiting, so the
    //      list captured before the await predates it and must not be reinstated as the floor.
    if (floorSeedEpochByQueue.get(queueKey) === seedEpoch) {
      lastPersistedByQueue.set(queueKey, stateList)
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
      lastPersistedByQueue.delete(queueKey)
      lastMutationNextByQueue.delete(queueKey)
      floorSeedEpochByQueue.delete(queueKey)
    }
  }
  next.then(cleanup, cleanup)
  return next
}

// Why: best-effort telemetry runs only after the note is on disk, so a throw here must not report a failed save.
function recordReviewNoteInteraction(get: () => AppState): void {
  try {
    get().recordFeatureInteraction?.('review-notes')
  } catch (err) {
    console.error('Failed to record review-notes interaction:', err)
  }
}

// Why: derive the next list inside the `set` updater so concurrent writes can't clobber each other via a stale closure.
function mutateComments(
  set: Parameters<StateCreator<AppState, [], [], DiffCommentsSlice>>[0],
  worktreeId: string,
  mutate: (existing: DiffComment[]) => DiffComment[] | null
): CommentMutation | null {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let previous: DiffComment[] | undefined
  let next: DiffComment[] | null = null
  let folderExecutionHostId: ReturnType<typeof getExecutionHostIdForFolderWorkspace> | undefined
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const target = findFolderWorkspaceOwner(s, scope.folderWorkspaceId)
      if (!target) {
        return {}
      }
      folderExecutionHostId = getExecutionHostIdForFolderWorkspace(s, scope.folderWorkspaceId)
      previous = target.diffComments
      const computed = mutate(previous ?? [])
      if (computed === null) {
        return {}
      }
      next = computed
      return {
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace === target ? { ...workspace, diffComments: computed } : workspace
        )
      }
    }
    const repoList = s.worktreesByRepo[repoId]
    if (!repoList) {
      return {}
    }
    const target = repoList.find((w) => w.id === worktreeId)
    if (!target) {
      return {}
    }
    previous = target.diffComments
    const computed = mutate(previous ?? [])
    if (computed === null) {
      return {}
    }
    next = computed
    const nextList: Worktree[] = repoList.map((w) =>
      w.id === worktreeId ? { ...w, diffComments: computed } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
  if (next === null) {
    return null
  }
  return { previous, next, folderExecutionHostId }
}

// Why: on IPC-write failure, roll back optimistic state so the renderer matches disk (identity-guarded below).
function rollback(
  set: Parameters<StateCreator<AppState, [], [], DiffCommentsSlice>>[0],
  worktreeId: string,
  previous: DiffComment[] | undefined,
  expectedCurrent: DiffComment[],
  folderExecutionHostId?: ReturnType<typeof getExecutionHostIdForFolderWorkspace>
): void {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  set((s) => {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const target = findFolderWorkspaceOwner(s, scope.folderWorkspaceId, folderExecutionHostId)
      if (!target || target.diffComments !== expectedCurrent) {
        return {}
      }
      return {
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace === target ? { ...workspace, diffComments: previous } : workspace
        )
      }
    }
    const repoList = s.worktreesByRepo[repoId]
    if (!repoList) {
      return {}
    }
    const target = repoList.find((w) => w.id === worktreeId)
    // Why: worktree gone since the mutation; bail before remapping so we don't allocate a new array identity and fire spurious notifications.
    if (!target) {
      return {}
    }
    // Why: only roll back if no later mutation replaced the array, else our stale `previous` would erase newer state.
    if (target.diffComments !== expectedCurrent) {
      return {}
    }
    const nextList: Worktree[] = repoList.map((w) =>
      w.id === worktreeId ? { ...w, diffComments: previous } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
}

export const createDiffCommentsSlice: StateCreator<AppState, [], [], DiffCommentsSlice> = (
  set,
  get
) => ({
  getDiffComments: (worktreeId) => {
    // Why: return the stable sentinel for a missing worktree so optional-worktree callers don't allocate a fresh [] and trigger re-renders.
    if (!worktreeId) {
      return EMPTY_COMMENTS as DiffComment[]
    }
    const scope = parseWorkspaceKey(worktreeId)
    const worktree =
      scope?.type === 'folder'
        ? findFolderWorkspaceOwner(get(), scope.folderWorkspaceId)
        : findWorktreeById(get().worktreesByRepo, worktreeId)
    if (!worktree?.diffComments) {
      // Why: cast the frozen sentinel to the mutable return type; runtime freeze makes accidental mutation throw.
      return EMPTY_COMMENTS as DiffComment[]
    }
    return worktree.diffComments
  },

  addDiffComment: async (input) => {
    const comment: DiffComment = normalizeDiffComment({
      ...input,
      id: generateId(),
      createdAt: Date.now()
    })
    const result = mutateComments(set, input.worktreeId, (existing) => [...existing, comment])
    if (!result) {
      return null
    }
    try {
      // Why: serialize through the per-worktree queue so concurrent writes can't land on disk out of call order.
      await enqueuePersist(set, input.worktreeId, get, result)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return null
    }
    recordReviewNoteInteraction(get)
    return comment
  },

  updateDiffComment: async (worktreeId, commentId, body) => {
    // Why: reject an empty edit so we never save a note that renders as a blank card; false means "not committed", keep the editor open.
    const trimmed = body.trim()
    if (!trimmed) {
      return false
    }

    // Why: distinguish "comment missing" (false; keep draft, likely edit-while-deleted) from "body unchanged" (true; close editor) before mutating.
    const existing = get().getDiffComments(worktreeId)
    const existingIdx = existing.findIndex((c) => c.id === commentId)
    if (existingIdx === -1) {
      return false
    }
    if (existing[existingIdx].body === trimmed) {
      return true
    }

    const result = mutateComments(set, worktreeId, (current) => {
      const idx = current.findIndex((c) => c.id === commentId)
      if (idx === -1) {
        return null
      }
      if (current[idx].body === trimmed) {
        return null
      }
      const next = current.slice()
      // Why: editing a sent note makes the agent's copy stale, so reset sentAt to re-queue it for the next Send.
      next[idx] = { ...current[idx], body: trimmed, sentAt: undefined }
      return next
    })
    if (!result) {
      // Why: comment vanished or the same body was already written between pre-check and set; treat as success so the editor closes.
      return true
    }
    try {
      await enqueuePersist(set, worktreeId, get, result)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
  },

  clearDeliveredDiffComments: async (worktreeId, comments) => {
    if (comments.length === 0) {
      return true
    }
    const snapshotsById = new Map(comments.map((comment) => [comment.id, comment]))
    const result = mutateComments(set, worktreeId, (existing) => {
      const next = existing.filter((comment) => {
        const snapshot = snapshotsById.get(comment.id)
        // Why: delivery is async; a note edited after its snapshot was sent is a fresh pending note that must stay visible.
        return !snapshot || !deliverySnapshotMatches(comment, snapshot)
      })
      return next.length === existing.length ? null : next
    })
    if (!result) {
      return true
    }
    try {
      await enqueuePersist(set, worktreeId, get, result)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
    recordReviewNoteInteraction(get)
    return true
  },

  markDiffCommentsSent: async (worktreeId, commentIds, sentAt = Date.now()) => {
    if (commentIds.length === 0) {
      return true
    }
    const ids = new Set(commentIds)
    const result = mutateComments(set, worktreeId, (existing) => {
      let changed = false
      const next = existing.map((comment) => {
        if (!ids.has(comment.id) || comment.sentAt === sentAt) {
          return comment
        }
        changed = true
        return { ...comment, sentAt }
      })
      return changed ? next : null
    })
    if (!result) {
      return true
    }
    try {
      await enqueuePersist(set, worktreeId, get, result)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
    recordReviewNoteInteraction(get)
    return true
  },

  deleteDiffComment: async (worktreeId, commentId) => {
    const result = mutateComments(set, worktreeId, (existing) => {
      const next = existing.filter((c) => c.id !== commentId)
      return next.length === existing.length ? null : next
    })
    if (!result) {
      return
    }
    try {
      // Why: serialize through the per-worktree queue so concurrent writes can't land out of call order.
      await enqueuePersist(set, worktreeId, get, result)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
    }
  },

  clearDiffComments: async (worktreeId) => {
    const result = mutateComments(set, worktreeId, (existing) =>
      existing.length === 0 ? null : []
    )
    if (!result) {
      return true
    }
    try {
      await enqueuePersist(set, worktreeId, get, result)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
  },

  clearDiffCommentsForFile: async (worktreeId, filePath) => {
    const result = mutateComments(set, worktreeId, (existing) => {
      const next = existing.filter((c) => c.filePath !== filePath)
      return next.length === existing.length ? null : next
    })
    if (!result) {
      return true
    }
    try {
      await enqueuePersist(set, worktreeId, get, result)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
  }
})
