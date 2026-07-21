/* eslint-disable max-lines -- Why: keeps note mutation, rollback, persistence ordering, and sent-state transitions under shared queue/rollback invariants. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DiffComment, Worktree } from '../../../../shared/types'
import { findWorktreeById, getRepoIdFromWorktreeId } from './worktree-helpers'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

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

// Why: one shared frozen sentinel so selectors don't return a fresh [] (avoids re-renders); freezing stops a stray push corrupting the shared instance for every consumer.
const EMPTY_COMMENTS: readonly DiffComment[] = Object.freeze([])

async function persist(
  settings: AppState['settings'],
  worktreeId: string,
  diffComments: DiffComment[]
): Promise<void> {
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
const persistQueueByWorktree: Map<string, Promise<void>> = new Map()

// Why: chain each write onto the prior promise so writes land in call order; both then handlers keep the chain alive past a failure.
// Why: queued work reads the latest list at dequeue time, and the returned promise settles for THIS write so callers can roll back.
function enqueuePersist(worktreeId: string, get: () => AppState): Promise<void> {
  const prior = persistQueueByWorktree.get(worktreeId) ?? Promise.resolve()
  const run = async (): Promise<void> => {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const repoList = get().worktreesByRepo[repoId]
    const target = repoList?.find((w) => w.id === worktreeId)
    const latest = (target?.diffComments ?? []).map(normalizeDiffComment)
    await persist(settingsForWorktreeOwner(get(), worktreeId), worktreeId, latest)
  }
  const next = prior.then(run, run)
  persistQueueByWorktree.set(worktreeId, next)
  // Why: clear the queue entry only if still the tail, so later enqueues chain onto the real in-flight promise.
  // Why: then(cleanup, cleanup) not finally, so a rejection is consumed here rather than re-thrown as unhandledRejection.
  const cleanup = (): void => {
    if (persistQueueByWorktree.get(worktreeId) === next) {
      persistQueueByWorktree.delete(worktreeId)
    }
  }
  next.then(cleanup, cleanup)
  return next
}

// Why: derive the next list inside the `set` updater so concurrent writes can't clobber each other via a stale closure.
function mutateComments(
  set: Parameters<StateCreator<AppState, [], [], DiffCommentsSlice>>[0],
  worktreeId: string,
  mutate: (existing: DiffComment[]) => DiffComment[] | null
): { previous: DiffComment[] | undefined; next: DiffComment[] } | null {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let previous: DiffComment[] | undefined
  let next: DiffComment[] | null = null
  set((s) => {
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
  return { previous, next }
}

// Why: on IPC-write failure, roll back optimistic state so the renderer matches disk (identity-guarded below).
function rollback(
  set: Parameters<StateCreator<AppState, [], [], DiffCommentsSlice>>[0],
  worktreeId: string,
  previous: DiffComment[] | undefined,
  expectedCurrent: DiffComment[]
): void {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  set((s) => {
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
    const worktree = findWorktreeById(get().worktreesByRepo, worktreeId)
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
      await enqueuePersist(input.worktreeId, get)
      get().recordFeatureInteraction?.('review-notes')
      return comment
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      // Why: rollback's identity guard no-ops if a later mutation already replaced the list, so a newer write can't be lost.
      rollback(set, input.worktreeId, result.previous, result.next)
      return null
    }
  },

  updateDiffComment: async (worktreeId, commentId, body) => {
    // Why: reject an empty edit so we never save a note that renders as a blank card; false means "not committed", keep the editor open.
    const trimmed = body.trim()
    if (!trimmed) {
      return false
    }

    // Why: distinguish "comment missing" (false; keep draft, likely edit-while-deleted) from "body unchanged" (true; close editor) before mutating.
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const repoList = get().worktreesByRepo[repoId]
    const target = repoList?.find((w) => w.id === worktreeId)
    const existing = target?.diffComments ?? []
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
      await enqueuePersist(worktreeId, get)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      rollback(set, worktreeId, result.previous, result.next)
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
      await enqueuePersist(worktreeId, get)
      get().recordFeatureInteraction?.('review-notes')
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      rollback(set, worktreeId, result.previous, result.next)
      return false
    }
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
      await enqueuePersist(worktreeId, get)
      get().recordFeatureInteraction?.('review-notes')
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      rollback(set, worktreeId, result.previous, result.next)
      return false
    }
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
      await enqueuePersist(worktreeId, get)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      rollback(set, worktreeId, result.previous, result.next)
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
      await enqueuePersist(worktreeId, get)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      rollback(set, worktreeId, result.previous, result.next)
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
      await enqueuePersist(worktreeId, get)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      rollback(set, worktreeId, result.previous, result.next)
      return false
    }
  }
})
