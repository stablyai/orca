import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DiffComment, Worktree } from '../../../../shared/types'
import { findWorktreeById, getRepoIdFromWorktreeId } from './worktree-helpers'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { createBrowserUuid } from '@/lib/browser-uuid'

export type DiffCommentsSlice = {
  getDiffComments: (worktreeId: string | null | undefined) => DiffComment[]
  addDiffComment: (input: Omit<DiffComment, 'id' | 'createdAt'>) => Promise<DiffComment | null>
  updateDiffComment: (worktreeId: string, commentId: string, body: string) => Promise<boolean>
  deleteDiffComment: (worktreeId: string, commentId: string) => Promise<void>
  clearDiffComments: (worktreeId: string) => Promise<boolean>
  clearDiffCommentsForFile: (worktreeId: string, filePath: string) => Promise<boolean>
}

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

  return {
    ...comment,
    ...(source !== undefined ? { source } : {}),
    ...(source === undefined ? { source: undefined } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(startLine === undefined ? { startLine: undefined } : {})
  }
}

// Why: return a stable reference when no comments exist so selectors don't
// produce a fresh `[]` on every store update. A new array identity would
// trigger re-renders in any consumer using referential equality.
// Frozen + typed `readonly` so an accidental `list.push(...)` on the returned
// value is both a runtime TypeError and a TypeScript compile error, preventing
// the sentinel from being corrupted globally.
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
    { worktree: worktreeId, diffComments },
    { timeoutMs: 15_000 }
  )
}

// Why: IPC writes from `persist` are not ordered with respect to each other.
// If two mutations (e.g. rapid add then delete, or two adds) are in flight
// concurrently, their `updateMeta` resolutions can arrive out of call order,
// letting an older snapshot overwrite a newer one on disk. We serialize per
// worktree so only one write runs at a time. We also defer reading the
// snapshot until the queued work actually starts — at dequeue time we pull
// the LATEST `diffComments` from the store — which collapses a burst of N
// mutations into at most 2 in-flight writes per worktree (1 running + 1
// queued) and guarantees the last disk write reflects the newest state.
const persistQueueByWorktree: Map<string, Promise<void>> = new Map()

// Why: chain each new write onto the prior promise for this worktree so
// writes land in call order. We use `.then(..., ..)` with both handlers so a
// failing previous write doesn't break the chain — we still proceed with the
// next write. The queued work reads the latest list from the store via
// `get()` at dequeue time (not via a captured parameter) so it writes the
// most recent snapshot rather than a stale one from when it was enqueued.
// The returned promise resolves/rejects when THIS specific write commits so
// callers can preserve their optimistic-update + rollback flow.
function enqueuePersist(worktreeId: string, get: () => AppState): Promise<void> {
  const prior = persistQueueByWorktree.get(worktreeId) ?? Promise.resolve()
  const run = async (): Promise<void> => {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const repoList = get().worktreesByRepo[repoId]
    const target = repoList?.find((w) => w.id === worktreeId)
    const latest = (target?.diffComments ?? []).map(normalizeDiffComment)
    await persist(get().settings, worktreeId, latest)
  }
  const next = prior.then(run, run)
  persistQueueByWorktree.set(worktreeId, next)
  // Why: once this write settles, clear the queue entry only if no later
  // write has been chained on top. Otherwise the map should keep pointing at
  // the latest tail so subsequent enqueues chain onto the real in-flight
  // tail, not a stale resolved promise. Use `then(cleanup, cleanup)` (not
  // `finally`) so a rejection on `next` is fully consumed by this branch —
  // otherwise the `.finally()` chain propagates the rejection as an
  // unhandledRejection even though the caller `await`s `next` in its own
  // try/catch.
  const cleanup = (): void => {
    if (persistQueueByWorktree.get(worktreeId) === next) {
      persistQueueByWorktree.delete(worktreeId)
    }
  }
  next.then(cleanup, cleanup)
  return next
}

// Why: derive the next comment list from the latest store snapshot inside
// the `set` updater so two concurrent writes (rapid add+delete, or a
// delete-while-add-in-flight) can't clobber each other via a stale closure.
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

// Why: if the IPC write fails, the optimistic renderer state drifts from
// disk. Roll back so what the user sees always matches what will survive a
// reload.
//
// Identity guard: we only revert when the current diffComments array is
// strictly identical (===) to the `next` array this mutation produced. If
// another mutation has already landed (e.g. Add B succeeded while Add A was
// still in flight), it will have replaced the array with a different
// identity. In that case we must leave the newer state alone — rolling back
// to our stale `previous` would erase B along with the failed A.
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
    // Why: if the worktree was removed between the optimistic mutation and
    // this rollback, there is nothing to restore. Bail out before remapping
    // `repoList` so we don't allocate a new outer-array identity and trigger
    // spurious subscriber notifications.
    if (!target) {
      return {}
    }
    // Why: only roll back if no other mutation landed since this one. If a
    // later write already replaced the comments array with a different
    // identity, our stale `previous` would erase that newer state.
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
    // Why: accept null/undefined so callers with an optional active worktree
    // can pass it through without allocating a fresh `[]` fallback each
    // render, which would defeat the `EMPTY_COMMENTS` sentinel's referential
    // stability and trigger spurious re-renders in useAppStore selectors.
    if (!worktreeId) {
      return EMPTY_COMMENTS as DiffComment[]
    }
    const worktree = findWorktreeById(get().worktreesByRepo, worktreeId)
    if (!worktree?.diffComments) {
      // Why: cast the frozen sentinel to the mutable `DiffComment[]` return
      // type. The array is frozen at runtime so accidental mutation throws;
      // the cast only hides the `readonly` marker from consumers that never
      // mutate the list in practice.
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
      // Why: enqueue through the per-worktree queue so concurrent mutations
      // cannot land on disk out of call order. The queued write reads the
      // latest store snapshot at dequeue time, so it will reflect any newer
      // mutation that landed after this one was enqueued.
      await enqueuePersist(input.worktreeId, get)
      return comment
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      // Why: rollback's identity guard will no-op if a later mutation has
      // already replaced the in-memory list, so losing a successful newer
      // write is not possible here even though we queued in order.
      rollback(set, input.worktreeId, result.previous, result.next)
      return null
    }
  },

  updateDiffComment: async (worktreeId, commentId, body) => {
    // Why: trim trailing whitespace but reject an entirely-empty edit so we
    // don't end up with a saved note that renders as a blank card. Callers
    // should treat `false` as "edit not committed" and keep the editor open
    // so the user can either type more or cancel explicitly.
    const trimmed = body.trim()
    if (!trimmed) {
      return false
    }

    // Why: look up the current state OUTSIDE mutateComments so we can
    // distinguish "comment missing" (return false — likely an edit-while-
    // deleted race; the card should keep its draft and not silently close)
    // from "body unchanged" (return true — benign no-op; the card can close
    // the editor without surfacing an error).
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
      next[idx] = { ...current[idx], body: trimmed }
      return next
    })
    if (!result) {
      // Why: between the pre-check and the set updater, the comment vanished
      // or another mutation already wrote the same body. Treat as success so
      // the caller closes its editor.
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

  deleteDiffComment: async (worktreeId, commentId) => {
    const result = mutateComments(set, worktreeId, (existing) => {
      const next = existing.filter((c) => c.id !== commentId)
      return next.length === existing.length ? null : next
    })
    if (!result) {
      return
    }
    try {
      // Why: enqueue through the per-worktree queue so concurrent mutations
      // cannot land on disk out of call order. See enqueuePersist for the
      // ordering invariant.
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
