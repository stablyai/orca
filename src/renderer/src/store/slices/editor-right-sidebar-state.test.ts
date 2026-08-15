import { describe, expect, it, vi } from 'vitest'
import { createEditorStore, createEditorTabsStore } from './editor-slice-test-harness'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

describe('createEditorSlice right sidebar state', () => {
  it('queues and safely consumes explicit editor focus requests', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { focusEditor: true }
    )

    const request = store.getState().pendingEditorFocusRequest
    expect(request).toMatchObject({
      fileId: '/repo/README.md',
      worktreeId: 'wt-1',
      viewStateId: expect.any(String),
      expiresAt: expect.any(Number)
    })

    store.getState().consumeEditorFocusRequest((request?.token ?? 0) + 1)
    expect(store.getState().pendingEditorFocusRequest).toBe(request)

    store.getState().consumeEditorFocusRequest(request?.token ?? 0)
    expect(store.getState().pendingEditorFocusRequest).toBeNull()
  })

  it('scopes the focus request to the unified tab that will render the file', () => {
    const store = createEditorTabsStore()
    const sourceTab = store.getState().createUnifiedTab('wt-1', 'terminal', { id: 'terminal-1' })
    const targetGroupId = store.getState().createEmptySplitGroup('wt-1', sourceTab.groupId, 'right')
    if (!targetGroupId) {
      throw new Error('expected split group')
    }

    store.getState().openFile(
      {
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { focusEditor: true, targetGroupId }
    )

    const editorTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'editor')
    expect(editorTab?.groupId).toBe(targetGroupId)
    // Why: the pane matches the handoff on its own tab id, so a drifting id silently drops it.
    expect(store.getState().pendingEditorFocusRequest?.viewStateId).toBe(editorTab?.id)
  })

  it('does not record markdown-file-created when opening an existing markdown file', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/docs/existing.md',
      relativePath: 'docs/existing.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    expect(store.getState().recordFeatureInteraction).not.toHaveBeenCalledWith(
      'markdown-file-created'
    )
  })

  it('right sidebar is closed by default', () => {
    const store = createEditorStore()
    expect(store.getState().rightSidebarOpen).toBe(false)
  })

  it('setRightSidebarOpen opens the sidebar', () => {
    const store = createEditorStore()
    store.getState().setRightSidebarOpen(true)
    expect(store.getState().rightSidebarOpen).toBe(true)
  })

  it('setRightSidebarOpen(false) after open closes it', () => {
    const store = createEditorStore()
    store.getState().setRightSidebarOpen(true)
    store.getState().setRightSidebarOpen(false)
    expect(store.getState().rightSidebarOpen).toBe(false)
  })

  it('toggleRightSidebar flips the state', () => {
    const store = createEditorStore()
    expect(store.getState().rightSidebarOpen).toBe(false)
    store.getState().toggleRightSidebar()
    expect(store.getState().rightSidebarOpen).toBe(true)
    store.getState().toggleRightSidebar()
    expect(store.getState().rightSidebarOpen).toBe(false)
  })

  it('setRightSidebarTab updates the global tab without writing a worktree entry', () => {
    const store = createEditorStore()

    store.getState().setRightSidebarTab('checks')

    expect(store.getState().rightSidebarTab).toBe('checks')
    expect(store.getState().rightSidebarTabByWorktree).toEqual({})
  })

  it('increments the right sidebar route request id for explicit route actions', () => {
    const store = createEditorStore()

    expect(store.getState().rightSidebarRouteRequestId).toBe(0)

    store.getState().setRightSidebarTab('checks')
    expect(store.getState().rightSidebarRouteRequestId).toBe(1)

    store.getState().setRightSidebarExplorerView('files')
    expect(store.getState().rightSidebarRouteRequestId).toBe(2)

    store.getState().showRightSidebarFiles()
    expect(store.getState().rightSidebarRouteRequestId).toBe(3)

    store.getState().showRightSidebarSearch()
    expect(store.getState().rightSidebarRouteRequestId).toBe(4)
  })

  it('setRightSidebarTab with no active worktree does not mutate the worktree map', () => {
    const store = createEditorStore()
    const remembered = { 'wt-1': 'checks' as const }
    store.setState({ activeWorktreeId: null, rightSidebarTabByWorktree: remembered })

    store.getState().setRightSidebarTab('checks')

    expect(store.getState().rightSidebarTab).toBe('checks')
    expect(store.getState().rightSidebarTabByWorktree).toBe(remembered)
  })

  it('showRightSidebarFiles opens Explorer files', () => {
    const store = createEditorStore()
    store.setState({ rightSidebarOpen: false, rightSidebarTab: 'checks' })

    store.getState().showRightSidebarFiles()

    expect(store.getState().rightSidebarOpen).toBe(true)
    expect(store.getState().rightSidebarTab).toBe('explorer')
    expect(store.getState().rightSidebarExplorerView).toBe('files')
    expect(store.getState().rightSidebarExplorerViewByWorktree).toEqual({ 'wt-1': 'files' })
  })

  it('showRightSidebarSearch opens Explorer search and requests focus without payload', () => {
    const store = createEditorStore()
    store.getState().updateFileSearchState('wt-1', {
      query: 'needle',
      results: { files: [], totalMatches: 1, truncated: false }
    })

    store.getState().showRightSidebarSearch()

    expect(store.getState().rightSidebarOpen).toBe(true)
    expect(store.getState().rightSidebarTab).toBe('explorer')
    expect(store.getState().rightSidebarExplorerView).toBe('search')
    expect(store.getState().rightSidebarExplorerViewByWorktree).toEqual({ 'wt-1': 'search' })
    expect(store.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: 'needle',
      results: { files: [], totalMatches: 1, truncated: false },
      focusRequestId: 1
    })
    expect(store.getState().fileSearchStateByWorktree['wt-1']?.seedRequestId).toBeUndefined()
  })

  it('showRightSidebarSearch seeds query and include together with one request', () => {
    const store = createEditorStore()

    store.getState().showRightSidebarSearch({ query: 'needle', includePattern: 'src/**' })

    expect(store.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: 'needle',
      includePattern: 'src/**',
      results: null,
      loading: false,
      seedRequestId: 1
    })
  })

  it('showRightSidebarSearch include-only focuses when the query is empty', () => {
    const store = createEditorStore()

    store.getState().showRightSidebarSearch({ includePattern: 'src/**' })

    expect(store.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: '',
      includePattern: 'src/**',
      focusRequestId: 1
    })
    expect(store.getState().fileSearchStateByWorktree['wt-1']?.seedRequestId).toBeUndefined()
  })

  it('showRightSidebarSearch include-only reruns an existing query', () => {
    const store = createEditorStore()
    store.getState().updateFileSearchState('wt-1', {
      query: 'needle',
      results: { files: [], totalMatches: 1, truncated: false }
    })

    store.getState().showRightSidebarSearch({ includePattern: 'src/**' })

    expect(store.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: 'needle',
      includePattern: 'src/**',
      results: null,
      loading: false,
      seedRequestId: 1
    })
  })

  it('revealInExplorer selects explorer globally without writing a worktree entry', () => {
    const store = createEditorStore()
    const remembered = { 'wt-1': 'explorer' as const, 'wt-2': 'checks' as const }
    store.setState({
      activeWorktreeId: 'wt-1',
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'search',
      rightSidebarTabByWorktree: remembered
    })

    store.getState().revealInExplorer('wt-2', '/repo/file.ts')

    expect(store.getState().rightSidebarOpen).toBe(true)
    expect(store.getState().rightSidebarTab).toBe('explorer')
    expect(store.getState().rightSidebarExplorerView).toBe('files')
    expect(store.getState().rightSidebarRouteRequestId).toBe(1)
    expect(store.getState().rightSidebarExplorerViewByWorktree).toEqual({ 'wt-2': 'files' })
    expect(store.getState().rightSidebarTabByWorktree).toBe(remembered)
    expect(store.getState().pendingExplorerReveal).toMatchObject({
      worktreeId: 'wt-2',
      filePath: '/repo/file.ts'
    })
  })

  it('collapses all expanded directories for one worktree', () => {
    const store = createEditorStore()
    store.setState({
      expandedDirs: {
        'wt-1': new Set(['/repo/src', '/repo/src/components']),
        'wt-2': new Set(['/other/packages'])
      }
    })

    store.getState().collapseAllDirs('wt-1')

    expect(store.getState().expandedDirs['wt-1']).toEqual(new Set())
    expect(store.getState().expandedDirs['wt-2']).toEqual(new Set(['/other/packages']))
  })

  it('keeps collapse all stable when the worktree has no expanded directories', () => {
    const store = createEditorStore()
    const expandedDirs = { 'wt-2': new Set(['/other/packages']) }
    store.setState({ expandedDirs })

    store.getState().collapseAllDirs('wt-1')

    expect(store.getState().expandedDirs).toBe(expandedDirs)
  })

  it('collapses one directory subtree without touching sibling directories', () => {
    const store = createEditorStore()
    store.setState({
      expandedDirs: {
        'wt-1': new Set(['/repo/src', '/repo/src/components', '/repo/src2', '/repo/tests']),
        'wt-2': new Set(['/other/src'])
      }
    })

    store.getState().collapseDirSubtree('wt-1', '/repo/src')

    expect(store.getState().expandedDirs['wt-1']).toEqual(new Set(['/repo/src2', '/repo/tests']))
    expect(store.getState().expandedDirs['wt-2']).toEqual(new Set(['/other/src']))
  })
})

describe('createEditorSlice file search seed state', () => {
  it('seeds file search with a one-shot request id', () => {
    const store = createEditorStore()

    store.getState().seedFileSearchQuery('wt-1', 'selectedText')

    expect(store.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: 'selectedText',
      results: null,
      loading: false,
      seedRequestId: 1
    })
  })

  it('preserves search options while replacing stale results and collapsed files', () => {
    const store = createEditorStore()
    store.getState().updateFileSearchState('wt-1', {
      query: 'old',
      caseSensitive: true,
      wholeWord: true,
      useRegex: true,
      includePattern: '*.ts',
      excludePattern: 'dist/**',
      results: { files: [], totalMatches: 1, truncated: false },
      loading: true,
      collapsedFiles: new Set(['/repo/file.ts'])
    })

    store.getState().seedFileSearchQuery('wt-1', 'next')

    const state = store.getState().fileSearchStateByWorktree['wt-1']
    expect(state).toMatchObject({
      query: 'next',
      caseSensitive: true,
      wholeWord: true,
      useRegex: true,
      includePattern: '*.ts',
      excludePattern: 'dist/**',
      results: null,
      loading: false,
      seedRequestId: 1
    })
    expect(state.collapsedFiles.size).toBe(0)
  })

  it('seeds file search include pattern with a one-shot request id', () => {
    const store = createEditorStore()

    store.getState().seedFileSearchIncludePattern('wt-1', 'src/**')

    expect(store.getState().fileSearchStateByWorktree['wt-1']).toMatchObject({
      query: '',
      includePattern: 'src/**',
      results: null,
      loading: false,
      seedRequestId: 1
    })
  })

  it('preserves search query and options while replacing stale scoped results', () => {
    const store = createEditorStore()
    store.getState().updateFileSearchState('wt-1', {
      query: 'needle',
      caseSensitive: true,
      wholeWord: true,
      useRegex: true,
      includePattern: 'old/**',
      excludePattern: 'dist/**',
      results: { files: [], totalMatches: 1, truncated: false },
      loading: true,
      collapsedFiles: new Set(['/repo/file.ts'])
    })

    store.getState().seedFileSearchIncludePattern('wt-1', 'src/**')

    const state = store.getState().fileSearchStateByWorktree['wt-1']
    expect(state).toMatchObject({
      query: 'needle',
      caseSensitive: true,
      wholeWord: true,
      useRegex: true,
      includePattern: 'src/**',
      excludePattern: 'dist/**',
      results: null,
      loading: false,
      seedRequestId: 1
    })
    expect(state.collapsedFiles.size).toBe(0)
  })

  it('consumes only the matching seed request id', () => {
    const store = createEditorStore()
    store.getState().seedFileSearchQuery('wt-1', 'selectedText')

    store.getState().consumeFileSearchSeedRequest('wt-1', 2)
    expect(store.getState().fileSearchStateByWorktree['wt-1']?.seedRequestId).toBe(1)

    store.getState().consumeFileSearchSeedRequest('wt-1', 1)
    expect(store.getState().fileSearchStateByWorktree['wt-1']?.seedRequestId).toBeUndefined()
  })
})
