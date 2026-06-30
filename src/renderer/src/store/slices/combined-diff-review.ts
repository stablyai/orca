import type { StateCreator } from 'zustand'
import type { CombinedDiffReviewState, Worktree } from '../../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import {
  markCombinedDiffFileReviewed,
  markCombinedDiffFileUnreviewed,
  normalizeCombinedDiffReviewState,
  reconcileCombinedDiffReviewState,
  type CombinedDiffReviewPresentFile
} from '../../components/editor/combined-diff-review-state'
import type { AppState } from '../types'
import { findWorktreeById, getRepoIdFromWorktreeId } from './worktree-helpers'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export type CombinedDiffReviewSlice = {
  getCombinedDiffReview: (worktreeId: string | null | undefined) => CombinedDiffReviewState
  setCombinedDiffFileViewed: (
    worktreeId: string,
    key: string,
    diffIdentity: string,
    viewed: boolean
  ) => Promise<boolean>
  reconcileCombinedDiffReview: (
    worktreeId: string,
    present: readonly CombinedDiffReviewPresentFile[]
  ) => Promise<void>
}

const EMPTY_COMBINED_DIFF_REVIEW: CombinedDiffReviewState = Object.freeze({
  version: 1,
  files: Object.freeze({})
})

// Why: persisted values from disk / cross-version SSH peers reach the store
// un-normalized; consumers dereference `.files` directly, so a malformed record
// (missing/non-object `files`) would crash the viewer render. Gate to the stable
// EMPTY sentinel here instead of normalizing per read (which would churn renders).
function isWellFormedCombinedDiffReview(value: unknown): value is CombinedDiffReviewState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { files?: unknown }).files === 'object' &&
    (value as { files?: unknown }).files !== null
  )
}

const persistQueueByWorktree: Map<string, Promise<void>> = new Map()

async function persist(
  settings: AppState['settings'],
  worktreeId: string,
  combinedDiffReview: CombinedDiffReviewState
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    await window.api.worktrees.updateMeta({
      worktreeId,
      updates: { combinedDiffReview }
    })
    return
  }
  await callRuntimeRpc(
    target,
    'worktree.set',
    { worktree: toRuntimeWorktreeSelector(worktreeId), combinedDiffReview },
    { timeoutMs: 15_000 }
  )
}

function settingsForWorktreeOwner(state: AppState, worktreeId: string): AppState['settings'] {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: runtimeEnvironmentId } as AppState['settings'])
}

function enqueuePersist(worktreeId: string, get: () => AppState): Promise<void> {
  const prior = persistQueueByWorktree.get(worktreeId) ?? Promise.resolve()
  const run = async (): Promise<void> => {
    const state = get()
    const target = findWorktreeById(state.worktreesByRepo, worktreeId)
    const latest = normalizeCombinedDiffReviewState(target?.combinedDiffReview)
    await persist(settingsForWorktreeOwner(state, worktreeId), worktreeId, latest)
  }
  const next = prior.then(run, run)
  persistQueueByWorktree.set(worktreeId, next)
  const cleanup = (): void => {
    if (persistQueueByWorktree.get(worktreeId) === next) {
      persistQueueByWorktree.delete(worktreeId)
    }
  }
  next.then(cleanup, cleanup)
  return next
}

function mutateReview(
  set: Parameters<StateCreator<AppState, [], [], CombinedDiffReviewSlice>>[0],
  worktreeId: string,
  mutate: (existing: CombinedDiffReviewState) => CombinedDiffReviewState
): { previous: CombinedDiffReviewState | undefined; next: CombinedDiffReviewState } | null {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let previous: CombinedDiffReviewState | undefined
  let next: CombinedDiffReviewState | null = null
  set((s) => {
    const repoList = s.worktreesByRepo[repoId]
    const target = repoList?.find((w) => w.id === worktreeId)
    if (!repoList || !target) {
      return {}
    }
    previous = target.combinedDiffReview
    const existing = normalizeCombinedDiffReviewState(previous)
    const computed = mutate(existing)
    if (computed === existing) {
      return {}
    }
    next = computed
    const nextList: Worktree[] = repoList.map((w) =>
      w.id === worktreeId ? { ...w, combinedDiffReview: computed } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
  return next ? { previous, next } : null
}

function rollback(
  set: Parameters<StateCreator<AppState, [], [], CombinedDiffReviewSlice>>[0],
  worktreeId: string,
  previous: CombinedDiffReviewState | undefined,
  expectedCurrent: CombinedDiffReviewState
): void {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  set((s) => {
    const repoList = s.worktreesByRepo[repoId]
    const target = repoList?.find((w) => w.id === worktreeId)
    if (!repoList || !target || target.combinedDiffReview !== expectedCurrent) {
      return {}
    }
    const nextList: Worktree[] = repoList.map((w) =>
      w.id === worktreeId ? { ...w, combinedDiffReview: previous } : w
    )
    return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } }
  })
}

export const createCombinedDiffReviewSlice: StateCreator<
  AppState,
  [],
  [],
  CombinedDiffReviewSlice
> = (set, get) => ({
  getCombinedDiffReview: (worktreeId) => {
    if (!worktreeId) {
      return EMPTY_COMBINED_DIFF_REVIEW
    }
    const stored = findWorktreeById(get().worktreesByRepo, worktreeId)?.combinedDiffReview
    return isWellFormedCombinedDiffReview(stored) ? stored : EMPTY_COMBINED_DIFF_REVIEW
  },

  setCombinedDiffFileViewed: async (worktreeId, key, diffIdentity, viewed) => {
    const now = Date.now()
    const result = mutateReview(set, worktreeId, (state) =>
      viewed
        ? markCombinedDiffFileReviewed(state, key, diffIdentity, now)
        : markCombinedDiffFileUnreviewed(state, key, now)
    )
    if (!result) {
      return true
    }
    try {
      await enqueuePersist(worktreeId, get)
      get().recordFeatureInteraction?.('review-viewed-files')
      return true
    } catch (err) {
      console.error('Failed to persist combined diff review state:', err)
      rollback(set, worktreeId, result.previous, result.next)
      return false
    }
  },

  reconcileCombinedDiffReview: async (worktreeId, present) => {
    const now = Date.now()
    const result = mutateReview(set, worktreeId, (state) =>
      reconcileCombinedDiffReviewState(state, present, now)
    )
    if (!result) {
      return
    }
    try {
      await enqueuePersist(worktreeId, get)
    } catch (err) {
      console.error('Failed to persist combined diff review state:', err)
      rollback(set, worktreeId, result.previous, result.next)
    }
  }
})
