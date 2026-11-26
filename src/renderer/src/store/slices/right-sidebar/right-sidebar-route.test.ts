import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getExplorerTreeView } from './right-sidebar-route'

const initial = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initial, true)
})

describe('opening Files search', () => {
  it('hides the tree in the same update that seeds a query, without the retired search view', () => {
    useAppStore.setState({ activeWorktreeId: 'wt-1' })
    useAppStore.getState().showRightSidebarSearch({ query: 'cart' })
    const state = useAppStore.getState()
    expect(state.rightSidebarExplorerView).toBe('files')
    expect(state.rightSidebarExplorerViewByWorktree['wt-1']).toBe('files')
    expect(state.fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: 'cart',
      seedKind: 'query',
      active: true
    })
    expect(getExplorerTreeView(state)).toBe('search')
  })

  it('marks Find in Folder as a filters seed so the live draft is kept', () => {
    useAppStore.setState({ activeWorktreeId: 'wt-1' })
    useAppStore.getState().updateFileSearchState('wt-1', { query: 'cart' })
    useAppStore.getState().showRightSidebarSearch({ includePattern: 'src/**' })
    expect(useAppStore.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      includePattern: 'src/**',
      seedKind: 'filters'
    })
  })
})
