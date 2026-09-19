// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeBox: { state: Record<string, unknown> } = { state: {} }

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state),
    { getState: () => storeBox.state }
  )
  return { useAppStore }
})

vi.mock('@/components/tab-group/tiled-pane-attention', () => ({
  selectTiledAgentsReconcileKey: (state: { reconcileKey: string }) => state.reconcileKey
}))

const notifyTiledAgentsPaneCapReached = vi.fn()
vi.mock('@/components/tab-group/tiled-agents-cap-notification', () => ({
  notifyTiledAgentsPaneCapReached: () => notifyTiledAgentsPaneCapReached()
}))

import { useAgentCardsReconciler } from './use-agent-cards-reconciler'

const WORKTREE_ID = 'wt-1'

function setState(
  reconcileKey: string,
  overflowTabIds: string[] = []
): { syncAgentCards: ReturnType<typeof vi.fn> } {
  const syncAgentCards = vi.fn(() => ({ carded: true, overflowTabIds }))
  storeBox.state = { reconcileKey, syncAgentCards }
  return { syncAgentCards }
}

describe('useAgentCardsReconciler', () => {
  beforeEach(() => {
    notifyTiledAgentsPaneCapReached.mockClear()
  })

  it('calls syncAgentCards once on mount and again only when the key changes', () => {
    const { syncAgentCards } = setState('1|t1')
    const { rerender } = renderHook(() => useAgentCardsReconciler(WORKTREE_ID))
    expect(syncAgentCards).toHaveBeenCalledTimes(1)
    expect(syncAgentCards).toHaveBeenCalledWith(WORKTREE_ID)

    rerender()
    expect(syncAgentCards).toHaveBeenCalledTimes(1)

    storeBox.state = { ...storeBox.state, reconcileKey: '1|t1,t2' }
    rerender()
    expect(syncAgentCards).toHaveBeenCalledTimes(2)
  })

  it('re-runs when the worktree id itself changes', () => {
    const { syncAgentCards } = setState('1|t1')
    const { rerender } = renderHook(({ worktreeId }) => useAgentCardsReconciler(worktreeId), {
      initialProps: { worktreeId: WORKTREE_ID }
    })
    expect(syncAgentCards.mock.calls).toEqual([[WORKTREE_ID]])

    rerender({ worktreeId: 'wt-2' })
    expect(syncAgentCards.mock.calls).toEqual([[WORKTREE_ID], ['wt-2']])
  })

  it('raises the cap toast only when overflowTabIds is non-empty', () => {
    setState('1|t1', [])
    renderHook(() => useAgentCardsReconciler(WORKTREE_ID))
    expect(notifyTiledAgentsPaneCapReached).not.toHaveBeenCalled()
  })

  it('raises the cap toast when the sync call reports overflow', () => {
    setState('1|t1,...,t10', ['t10'])
    renderHook(() => useAgentCardsReconciler(WORKTREE_ID))
    expect(notifyTiledAgentsPaneCapReached).toHaveBeenCalledTimes(1)
  })
})
