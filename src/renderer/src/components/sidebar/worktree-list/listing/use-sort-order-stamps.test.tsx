// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { useSidebarWorktreeSortOrder } from './use-sort-order'

vi.mock('@/lib/sidebar-list-session', () => ({ useSidebarListSession: () => {} }))

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const repoMap = new Map([[repo.id, repo]])

const identities = (...worktrees: Worktree[]): string[] => worktrees.map(getWorktreeHostIdentity)

function setRows(worktrees: Worktree[]): void {
  act(() => {
    useAppStore.setState({ worktreesByRepo: { [repo.id]: worktrees } })
  })
}

describe('useSidebarWorktreeSortOrder by stamps', () => {
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('re-sorts as soon as a stamp lands, with no settle window', () => {
    const a = makeWorktree(`${repo.id}::/a`, 'a', { repoId: repo.id, lastActivityAt: 2 })
    const b = makeWorktree(`${repo.id}::/b`, 'b', { repoId: repo.id, lastActivityAt: 1 })
    useAppStore.setState({ sortBy: 'smart', worktreesByRepo: { [repo.id]: [a, b] } })
    const { result } = renderHook(() => useSidebarWorktreeSortOrder({ repoMap, sortBy: 'smart' }))
    expect(result.current).toEqual(identities(a, b))

    const askingB: Worktree = { ...b, smartTier: 'needs-you', smartAt: 3 }
    setRows([a, askingB])
    expect(result.current).toEqual(identities(b, a))
    const c = makeWorktree(`${repo.id}::/c`, 'c', { repoId: repo.id, lastActivityAt: 9 })
    setRows([a, askingB, c])
    expect(result.current).toEqual(identities(b, c, a))
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
    expect(first).toEqual(identities(a, z))
    act(() => {
      useAppStore.setState({
        worktreesByRepo: { [repo.id]: [{ ...a, isUnread: true }], [other.id]: [z] }
      })
    })
    expect(result.current).toBe(first)
    rerender({ map: maps.after })
    expect(result.current).toEqual(identities(z, a))
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
    expect(result.current).toEqual(identities(done, working))
    setRows([{ ...done, isUnread: false }, working])
    expect(result.current).toEqual(identities(working, done))
  })
})
