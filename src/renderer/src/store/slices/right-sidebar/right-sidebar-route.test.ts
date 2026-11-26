import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { createUIStore, makePersistedUI } from '../ui/ui-slice-test-harness'
import { getExplorerTreeView } from './right-sidebar-route'

const initial = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initial, true)
})

describe('Files search routing', () => {
  it('hydrates a persisted Search tab or view as the Files view', () => {
    for (const ui of [
      { rightSidebarTab: 'search' },
      { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'search' }
    ] as const) {
      const store = createUIStore()
      store.getState().hydratePersistedUI(makePersistedUI(ui))
      expect(store.getState().rightSidebarTab).toBe('explorer')
      expect(store.getState().rightSidebarExplorerView).toBe('files')
    }
  })

  it('never shows an open tree while a seeded search opens', () => {
    useAppStore.setState({ activeWorktreeId: 'wt-1', rightSidebarOpen: false })
    const treeViews: string[] = []
    const stop = useAppStore.subscribe((state) => {
      if (state.rightSidebarOpen && state.rightSidebarTab === 'explorer') {
        treeViews.push(getExplorerTreeView(state))
      }
    })
    useAppStore.getState().showRightSidebarSearch({ query: 'cart' })
    stop()
    expect(treeViews).toEqual(['search'])
    expect(useAppStore.getState().rightSidebarExplorerView).toBe('files')
    expect(useAppStore.getState().fileSearchStateByWorktree['wt-1']?.seedKind).toBe('query')
  })

  it('keeps a pending query seed when Find in Folder follows it', () => {
    useAppStore.setState({ activeWorktreeId: 'wt-1' })
    useAppStore.getState().showRightSidebarSearch({ query: 'cart' })
    useAppStore.getState().showRightSidebarSearch({ includePattern: 'src/**' })
    expect(useAppStore.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: 'cart',
      includePattern: 'src/**',
      seedKind: 'query'
    })
  })
})
