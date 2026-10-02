// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hostActive: false,
  setHostActive: (_active: boolean) => {},
  treeMounts: 0,
  treeUnmounts: 0,
  treeRenders: 0,
  enter: () => {},
  exit: () => {},
  listFiles: vi.fn(),
  search: vi.fn(),
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn()
}))

const state = {
  rightSidebarExplorerView: 'files',
  showRightSidebarFiles: () => {},
  showRightSidebarSearch: () => {},
  activeWorktreeId: 'wt-1',
  expandedDirs: {},
  collapseAllDirs: () => {},
  activeFileId: null,
  openFiles: [],
  rightSidebarOpen: true,
  showDotfilesByWorktree: {},
  toggleShowDotfilesForWorktree: () => {},
  explorerDisplayRootByWorktree: {}
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state)
}))
vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: 'wt-1', repoId: 'repo-1', path: '/home/allen/codes' }),
  useRepoById: () => null
}))
vi.mock('./FileExplorerFilesTreePane', () => ({
  FileExplorerFilesTreePane: () => {
    h.treeRenders += 1
    useEffect(() => {
      h.treeMounts += 1
      return () => {
        h.treeUnmounts += 1
      }
    }, [])
    return <div data-testid="tree" />
  }
}))
vi.mock('./FileExplorerToolbar', () => ({
  FileExplorerToolbar: () => <div data-testid="toolbar" />
}))
vi.mock('./FileExplorerHostBar', () => ({
  FileExplorerHostBar: () => <div data-testid="host-bar" />
}))
vi.mock('./FileExplorerHostList', () => ({
  FileExplorerHostList: () => <div data-testid="host-list" />
}))
vi.mock('./FileExplorerBackgroundMenu', () => ({ FileExplorerBackgroundMenu: () => null }))
vi.mock('./SearchResultsPane', () => ({ SearchResultsPane: () => null }))
vi.mock('./SearchQueryRow', () => ({ SearchQueryRow: () => <div data-testid="contents-query" /> }))
vi.mock('./SearchFilters', () => ({ SearchFilters: () => null }))
vi.mock('./useFileSearchPanel', () => ({
  useFileSearchPanel: () => ({
    activeWorktreeId: 'wt-1',
    queryRowProps: {},
    filtersProps: {},
    resultsProps: {}
  })
}))
vi.mock('./useFileExplorerTree', () => ({
  useFileExplorerTree: () => ({ dirCache: {}, refreshTree: vi.fn() })
}))
vi.mock('./use-file-explorer-name-filter', () => ({
  useFileExplorerNameFilter: () => ({
    nameFilterQuery: '',
    setNameFilterQuery: vi.fn(),
    nameFilterCollapsedPaths: new Set(),
    setNameFilterCollapsedPaths: vi.fn(),
    hasNameFilter: false,
    nameFilterFiles: { loading: false },
    nameFilterSource: null,
    handleClearNameFilter: vi.fn()
  })
}))
vi.mock('./useFileExplorerVisibleRowProjection', () => ({
  useFileExplorerVisibleRowProjection: () => ({
    rowProjection: { getVisibleCount: () => 0, getRowByPath: () => null },
    ignoredByRelativePath: new Map(),
    showGitIgnoredFiles: false,
    nameFilterExpandedPaths: new Set(),
    toggleGitIgnoredFiles: vi.fn()
  })
}))
vi.mock('./useFileExplorerManualRefresh', () => ({
  useFileExplorerManualRefresh: () => ({
    isRefreshing: false,
    showRefreshSpinner: false,
    handleRefresh: vi.fn()
  })
}))
vi.mock('./useFileExplorerSelection', () => ({
  useFileExplorerSelection: () => ({ selectedPath: null })
}))
vi.mock('./use-file-explorer-tree-pane-state', () => ({
  useFileExplorerTreePaneState: () => ({
    inlineInputState: { inlineInput: null, startNew: vi.fn() },
    rowScrolling: { setExplorerShellRef: vi.fn() },
    dragDrop: { dragSourcePath: null, isNativeDragOver: false }
  })
}))
vi.mock('./use-file-explorer-background-menu', () => ({
  useFileExplorerBackgroundMenu: () => ({
    bgMenuOpen: false,
    setBgMenuOpen: vi.fn(),
    bgMenuPoint: null,
    handleExplorerBackgroundContextMenuCapture: vi.fn(),
    handleExplorerBackgroundDoubleClick: vi.fn()
  })
}))
vi.mock('./use-file-explorer-scope-transition', () => ({
  useFileExplorerScopeTransition: () => {}
}))
vi.mock('./use-file-explorer-host-mode', async () => {
  const { useState } = await import('react')
  return {
    useFileExplorerHostMode: () => {
      const [active, setActive] = useState(h.hostActive)
      h.setHostActive = setActive
      return {
        active,
        filterQuery: '',
        setFilterQuery: vi.fn(),
        available: true,
        browser: {}
      }
    }
  }
})

import FileExplorer from './FileExplorer'

let root: Root
let container: HTMLDivElement

async function render(): Promise<void> {
  await act(async () => {
    root.render(<FileExplorer key="explorer" />)
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  h.hostActive = false
  h.treeMounts = 0
  h.treeUnmounts = 0
  h.treeRenders = 0
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: {
        listFiles: h.listFiles,
        search: h.search,
        watchWorktree: h.watchWorktree,
        unwatchWorktree: h.unwatchWorktree
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('FileExplorer Host mode', () => {
  it('overlays the Host list without remounting, re-rendering, or re-watching the tree', async () => {
    await render()
    const rendersBefore = h.treeRenders
    expect(h.treeMounts).toBe(1)
    expect(container.querySelector('[data-testid="host-list"]')).toBeNull()

    for (const active of [true, false, true, false]) {
      await act(async () => h.setHostActive(active))
      expect(container.querySelector('[data-testid="host-list"]') !== null).toBe(active)
    }

    expect(h.treeRenders, 'toggling Host mode does not re-render the Project tree').toBe(
      rendersBefore
    )
    expect(h.treeMounts).toBe(1)
    expect(h.treeUnmounts).toBe(0)
    expect(h.watchWorktree).not.toHaveBeenCalled()
    expect(h.unwatchWorktree).not.toHaveBeenCalled()
  })

  it('makes the hidden tree inert and swaps in the Host bar and list', async () => {
    h.hostActive = true
    await render()

    const tree = container.querySelector('[data-testid="tree"]')
    expect(tree?.closest('[inert]')).not.toBeNull()
    expect(container.querySelector('[data-testid="host-bar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="host-list"]')).not.toBeNull()
    expect(h.listFiles).not.toHaveBeenCalled()
    expect(h.search).not.toHaveBeenCalled()
  })

  it('keeps the Project tree and query rows interactive until Host mode makes them inert', async () => {
    await render()
    expect(
      container.querySelector('[data-testid="tree"]')?.closest('[inert]'),
      'Project tree is interactive outside Host mode'
    ).toBeNull()
    expect(
      container.querySelector('[data-testid="host-bar"]'),
      'no Host bar outside Host mode'
    ).toBeNull()
    const projectFilter = container.querySelector('input[aria-label="Find files"]')
    const contentsQuery = container.querySelector('[data-testid="contents-query"]')
    expect(projectFilter?.closest('[inert]')).toBeNull()
    expect(contentsQuery?.closest('[inert]')).toBeNull()

    await act(async () => h.setHostActive(true))

    expect(projectFilter?.isConnected).toBe(true)
    expect(projectFilter?.closest('[inert]')).not.toBeNull()
    expect(contentsQuery?.closest('[inert]')).not.toBeNull()
  })
})
