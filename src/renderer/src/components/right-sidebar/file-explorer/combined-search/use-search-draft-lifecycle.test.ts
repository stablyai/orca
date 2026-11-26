// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getInitialSearchDraft, useSearchDraftLifecycle } from './use-search-draft-lifecycle'

const initial = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

function mountField(worktreeId: string, query: string, runTextSearch = vi.fn()) {
  const hook = renderHook(() =>
    useSearchDraftLifecycle({
      activeWorktreeId: worktreeId,
      query,
      runTextSearch,
      updateActiveSearchState: (updates) =>
        useAppStore.getState().updateFileSearchState(worktreeId, updates)
    })
  )
  return { ...hook, runTextSearch }
}

describe('search draft per worktree', () => {
  it('keeps each worktree draft across a switch and reruns it on return', () => {
    expect(getInitialSearchDraft('wt-a')).toBe('')
    const fieldA = mountField('wt-a', 'cart')
    expect(useAppStore.getState().fileSearchStateByWorktree['wt-a']?.active).toBe(true)
    fieldA.unmount()

    expect(getInitialSearchDraft('wt-b')).toBe('')
    mountField('wt-b', '').unmount()

    expect(getInitialSearchDraft('wt-a')).toBe('cart')
    const back = mountField('wt-a', getInitialSearchDraft('wt-a'))
    expect(back.runTextSearch).toHaveBeenCalledWith('cart')
  })

  it('opens on a pending query seed instead of the old draft', () => {
    mountField('wt-a', 'cart').unmount()
    useAppStore.setState({ activeWorktreeId: 'wt-a' })
    useAppStore.getState().showRightSidebarSearch({ query: 'checkout' })
    expect(getInitialSearchDraft('wt-a')).toBe('checkout')
  })
})
