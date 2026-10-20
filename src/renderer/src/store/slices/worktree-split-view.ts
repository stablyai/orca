import type { StateCreator } from 'zustand'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '../types'

/** Two worktrees shown side by side; whichever one is `activeWorktreeId` owns input. */
export type WorktreeSplitViewPair = {
  leftWorktreeId: string
  leftExecutionHostId: ExecutionHostId | null
  rightWorktreeId: string
  rightExecutionHostId: ExecutionHostId | null
}

/** Left half's flex-grow share, set on the surfaces container so a divider drag skips React. */
export const WORKTREE_SPLIT_LEFT_FLEX_VAR = '--worktree-split-left'

export const WORKTREE_SPLIT_VIEW_MIN_RATIO = 0.15
export const WORKTREE_SPLIT_VIEW_MAX_RATIO = 0.85

export type WorktreeSplitViewSlice = {
  worktreeSplitViewPair: WorktreeSplitViewPair | null
  /** Left side's share of the width. */
  worktreeSplitViewRatio: number
  /** Pairs `worktreeId` with the active worktree, the new one on the right. */
  openWorktreeInSplitView: (worktreeId: string, executionHostId?: ExecutionHostId | null) => boolean
  closeWorktreeSplitView: () => void
  setWorktreeSplitViewRatio: (ratio: number) => void
}

export function clampWorktreeSplitViewRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return 0.5
  }
  return Math.min(WORKTREE_SPLIT_VIEW_MAX_RATIO, Math.max(WORKTREE_SPLIT_VIEW_MIN_RATIO, ratio))
}

export function isWorktreeInSplitViewPair(
  pair: WorktreeSplitViewPair | null | undefined,
  worktreeId: string | null
): boolean {
  return (
    pair != null &&
    worktreeId !== null &&
    (pair.leftWorktreeId === worktreeId || pair.rightWorktreeId === worktreeId)
  )
}

/** The other side of the split while the active worktree is in the pair, else null. */
export function selectWorktreeSplitPartnerId(
  state: Pick<AppState, 'worktreeSplitViewPair' | 'activeWorktreeId'>
): string | null {
  const { worktreeSplitViewPair: pair, activeWorktreeId } = state
  if (!pair || !isWorktreeInSplitViewPair(pair, activeWorktreeId)) {
    return null
  }
  return pair.leftWorktreeId === activeWorktreeId ? pair.rightWorktreeId : pair.leftWorktreeId
}

/** True when the worktree's surface is on screen: the active one, or its split-view partner. */
export function isWorktreeSurfaceShown(
  {
    activeView,
    renderedActiveWorktreeId,
    splitPartnerWorktreeId
  }: {
    activeView: string
    renderedActiveWorktreeId: string | null
    splitPartnerWorktreeId: string | null
  },
  worktreeId: string
): boolean {
  return (
    activeView === 'terminal' &&
    (renderedActiveWorktreeId === worktreeId || splitPartnerWorktreeId === worktreeId)
  )
}

/** State patch that ends the split when a removed worktree was one of its sides. */
export function splitViewPairAfterRemoval(
  s: Pick<AppState, 'worktreeSplitViewPair'>,
  removedWorktreeIds: ReadonlySet<string>
): Partial<Pick<AppState, 'worktreeSplitViewPair'>> {
  const pair = s.worktreeSplitViewPair
  return pair &&
    (removedWorktreeIds.has(pair.leftWorktreeId) || removedWorktreeIds.has(pair.rightWorktreeId))
    ? { worktreeSplitViewPair: null }
    : {}
}

/** State patch that ends the split when a purged host's copy of a twin worktree was one of its sides. */
export function splitViewPairAfterHostTwinPurge(
  s: Pick<AppState, 'worktreeSplitViewPair'>,
  twinWorktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId
): Partial<Pick<AppState, 'worktreeSplitViewPair'>> {
  const pair = s.worktreeSplitViewPair
  const purgedSide = (worktreeId: string, sideHostId: ExecutionHostId | null) =>
    sideHostId === hostId && twinWorktreeIds.has(worktreeId)
  return pair &&
    (purgedSide(pair.leftWorktreeId, pair.leftExecutionHostId) ||
      purgedSide(pair.rightWorktreeId, pair.rightExecutionHostId))
    ? { worktreeSplitViewPair: null }
    : {}
}

/** State patch that ends the split once the user activates a worktree outside the pair. */
export function splitViewPairAfterActivation(
  s: Partial<Pick<AppState, 'worktreeSplitViewPair'>>,
  worktreeId: string | null
): Partial<Pick<AppState, 'worktreeSplitViewPair'>> {
  return s.worktreeSplitViewPair && !isWorktreeInSplitViewPair(s.worktreeSplitViewPair, worktreeId)
    ? { worktreeSplitViewPair: null }
    : {}
}

/** State patch that re-points a side after a worktree id changes. */
export function splitViewPairAfterRename(
  s: Pick<AppState, 'worktreeSplitViewPair'>,
  fromWorktreeId: string,
  toWorktreeId: string
): Partial<Pick<AppState, 'worktreeSplitViewPair'>> {
  const pair = s.worktreeSplitViewPair
  if (!pair || !isWorktreeInSplitViewPair(pair, fromWorktreeId)) {
    return {}
  }
  return {
    worktreeSplitViewPair: {
      ...pair,
      leftWorktreeId: pair.leftWorktreeId === fromWorktreeId ? toWorktreeId : pair.leftWorktreeId,
      rightWorktreeId: pair.rightWorktreeId === fromWorktreeId ? toWorktreeId : pair.rightWorktreeId
    }
  }
}

export function getWorktreeSplitViewSideHostId(
  pair: WorktreeSplitViewPair,
  worktreeId: string
): ExecutionHostId | null {
  return pair.leftWorktreeId === worktreeId ? pair.leftExecutionHostId : pair.rightExecutionHostId
}

export const createWorktreeSplitViewSlice: StateCreator<
  AppState,
  [],
  [],
  WorktreeSplitViewSlice
> = (set, get) => ({
  worktreeSplitViewPair: null,
  worktreeSplitViewRatio: 0.5,

  openWorktreeInSplitView: (worktreeId, executionHostId = null) => {
    const { activeWorktreeId, activeWorkspaceExecutionHostId } = get()
    if (!activeWorktreeId || activeWorktreeId === worktreeId) {
      return false
    }
    set({
      worktreeSplitViewPair: {
        leftWorktreeId: activeWorktreeId,
        leftExecutionHostId: activeWorkspaceExecutionHostId,
        rightWorktreeId: worktreeId,
        rightExecutionHostId: executionHostId
      }
    })
    return true
  },

  closeWorktreeSplitView: () => {
    if (get().worktreeSplitViewPair !== null) {
      set({ worktreeSplitViewPair: null })
    }
  },

  setWorktreeSplitViewRatio: (ratio) => {
    const next = clampWorktreeSplitViewRatio(ratio)
    if (next !== get().worktreeSplitViewRatio) {
      set({ worktreeSplitViewRatio: next })
    }
  }
})
