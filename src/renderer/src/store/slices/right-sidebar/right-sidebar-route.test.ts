import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getExplorerTreeView, normalizeRightSidebarRoute } from './right-sidebar-route'

const initial = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initial, true)
})

describe('Files search routing', () => {
  it('restores a persisted Search tab or view as the Files view', () => {
    expect(normalizeRightSidebarRoute('search')).toEqual({
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files'
    })
    expect(normalizeRightSidebarRoute('explorer')).toEqual({
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files'
    })
  })

  it('opens search without ever writing the retired search view', () => {
    useAppStore.setState({ activeWorktreeId: 'wt-1' })
    useAppStore.getState().showRightSidebarSearch({ query: 'cart' })
    const state = useAppStore.getState()
    expect(state.rightSidebarExplorerView).toBe('files')
    expect(state.rightSidebarExplorerViewByWorktree['wt-1']).toBe('files')
    expect(state.fileSearchStateByWorktree['wt-1']?.query).toBe('cart')
  })

  it('reports the tree as hidden only while a query shows results', () => {
    expect(getExplorerTreeView({ rightSidebarExplorerView: 'files' })).toBe('files')
    useAppStore.getState().setFileExplorerSearchActive(true)
    expect(getExplorerTreeView(useAppStore.getState())).toBe('search')
  })
})
