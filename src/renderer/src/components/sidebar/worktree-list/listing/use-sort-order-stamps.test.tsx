// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { useSidebarWorktreeSortOrder } from './use-sort-order'

vi.mock('../../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))
vi.mock('@/lib/sidebar-list-session', () => ({ useSidebarListSession: () => {} }))
const persistOrder = vi.hoisted(() => vi.fn())
vi.mock('@/lib/worktree-sort-order-persistence', () => ({
  persistWorktreeSortOrderByHost: persistOrder
}))

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const repoMap = new Map([[repo.id, repo]])

function setRows(worktrees: Worktree[]): void {
  act(() => {
    useAppStore.setState({ worktreesByRepo: { [repo.id]: worktrees } })
  })
}

describe('useSidebarWorktreeSortOrder with the switch on', () => {
  afterEach(() => {
    persistOrder.mockClear()
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('re-sorts as soon as a stamp lands, with no settle window and no saved order', () => {
    const a = makeWorktree(`${repo.id}::/a`, 'a', { repoId: repo.id, lastActivityAt: 2 })
    const b = makeWorktree(`${repo.id}::/b`, 'b', { repoId: repo.id, lastActivityAt: 1 })
    useAppStore.setState({ sortBy: 'smart', worktreesByRepo: { [repo.id]: [a, b] } })
    const { result } = renderHook(() => useSidebarWorktreeSortOrder({ repoMap, sortBy: 'smart' }))
    expect(result.current).toEqual([a.id, b.id])

    const askingB: Worktree = { ...b, smartTier: 'needs-you', smartAt: 3 }
    setRows([a, askingB])
    expect(result.current).toEqual([b.id, a.id])
    // The store keeps no settled epoch: a bump with a new row would settle it at once otherwise.
    const c = makeWorktree(`${repo.id}::/c`, 'c', { repoId: repo.id, lastActivityAt: 9 })
    act(() => {
      useAppStore.setState((s) => ({
        sortEpoch: s.sortEpoch + 1,
        worktreesByRepo: { [repo.id]: [a, askingB, c] }
      }))
    })
    expect(useAppStore.getState().settledSortEpoch).toBe(initialState.settledSortEpoch)
    expect(result.current).toEqual([b.id, c.id, a.id])
    expect(persistOrder).not.toHaveBeenCalled()
  })

  it('keeps the same order array on an unrelated row write, and re-sorts on a repo rename', () => {
    const other = { ...makeRepo(), id: 'repo-2', displayName: 'Zed' }
    const a = makeWorktree(`${repo.id}::/a`, 'a', { repoId: repo.id })
    const z = makeWorktree(`${other.id}::/z`, 'z', { repoId: other.id })
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [a], [other.id]: [z] } })
    const maps = {
      before: new Map([
        [repo.id, repo],
        [other.id, other]
      ]),
      after: new Map([
        [repo.id, repo],
        [other.id, { ...other, displayName: 'Aardvark' }]
      ])
    }
    const { result, rerender } = renderHook(
      ({ map }) => useSidebarWorktreeSortOrder({ repoMap: map, sortBy: 'repo' }),
      { initialProps: { map: maps.before } }
    )
    const first = result.current
    expect(first).toEqual([a.id, z.id])
    act(() => {
      useAppStore.setState({
        worktreesByRepo: { [repo.id]: [{ ...a, isUnread: true }], [other.id]: [z] }
      })
    })
    expect(result.current).toBe(first)
    rerender({ map: maps.after })
    expect(result.current).toEqual([z.id, a.id])
  })

  it('a Done row drops to the rest once its workspace is read', () => {
    const done = makeWorktree(`${repo.id}::/done`, 'done', {
      repoId: repo.id,
      lastActivityAt: 5,
      smartTier: 'done',
      smartAt: 5,
      isUnread: true
    })
    const working = makeWorktree(`${repo.id}::/working`, 'working', {
      repoId: repo.id,
      lastActivityAt: 1,
      smartTier: 'working',
      smartAt: 1
    })
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [done, working] } })
    const { result } = renderHook(() => useSidebarWorktreeSortOrder({ repoMap, sortBy: 'smart' }))
    expect(result.current).toEqual([done.id, working.id])
    setRows([{ ...done, isUnread: false }, working])
    expect(result.current).toEqual([working.id, done.id])
  })
})
