/* eslint-disable max-lines */

import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createEditorSlice } from './editor'
import { createTabsSlice } from './tabs'
import type { AppState } from '../types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { openHttpLinkMock } = vi.hoisted(() => ({ openHttpLinkMock: vi.fn() }))
vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: openHttpLinkMock
}))

function createEditorStore(): StoreApi<AppState> {
  // Only the editor slice + activeWorktreeId are needed for these tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

function createEditorTabsStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    ...createTabsSlice(...(args as Parameters<typeof createTabsSlice>)),
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

async function flushAsyncRemoteRefresh(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

describe('createEditorSlice right sidebar state', () => {
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

    store.getState().setRightSidebarTab('search')

    expect(store.getState().rightSidebarTab).toBe('search')
    expect(store.getState().rightSidebarTabByWorktree).toEqual({})
  })

  it('setRightSidebarTab with no active worktree does not mutate the worktree map', () => {
    const store = createEditorStore()
    const remembered = { 'wt-1': 'checks' as const }
    store.setState({ activeWorktreeId: null, rightSidebarTabByWorktree: remembered })

    store.getState().setRightSidebarTab('search')

    expect(store.getState().rightSidebarTab).toBe('search')
    expect(store.getState().rightSidebarTabByWorktree).toBe(remembered)
  })

  it('revealInExplorer selects explorer globally without writing a worktree entry', () => {
    const store = createEditorStore()
    const remembered = { 'wt-1': 'search' as const, 'wt-2': 'checks' as const }
    store.setState({
      activeWorktreeId: 'wt-1',
      rightSidebarTab: 'search',
      rightSidebarTabByWorktree: remembered
    })

    store.getState().revealInExplorer('wt-2', '/repo/file.ts')

    expect(store.getState().rightSidebarOpen).toBe(true)
    expect(store.getState().rightSidebarTab).toBe('explorer')
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

describe('createEditorSlice openDiff', () => {
  it('keeps staged and unstaged diffs in separate tabs', () => {
    const store = createEditorStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      'wt-1::diff::unstaged::file.ts',
      'wt-1::diff::staged::file.ts'
    ])
  })

  it('repairs an existing diff tab entry to the correct mode and staged state', () => {
    const store = createEditorStore()

    store.setState({
      openFiles: [
        {
          id: 'wt-1::diff::staged::file.ts',
          filePath: '/repo/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ],
      activeFileId: null,
      activeFileIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabType: 'terminal'
    })

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', true)

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::staged::file.ts',
        mode: 'diff',
        diffSource: 'staged'
      })
    ])
    expect(store.getState().activeFileId).toBe('wt-1::diff::staged::file.ts')
  })
})

describe('createEditorSlice floating editor activation', () => {
  it('creates a visible floating editor tab when the floating workspace is empty', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/tmp/orca/notes.md',
        relativePath: 'notes.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    const tab = store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(tab).toMatchObject({
      contentType: 'editor',
      entityId: '/tmp/orca/notes.md',
      label: 'notes.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })
    expect(store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).toMatchObject({
      activeTabId: tab?.id,
      tabOrder: [tab?.id]
    })
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      '/tmp/orca/notes.md'
    )
  })

  it('opens floating markdown tabs without changing the main active editor surface', () => {
    const store = createEditorStore()
    store.setState({
      activeFileId: '/repo/main.md',
      activeTabType: 'editor',
      activeFileIdByWorktree: { 'wt-1': '/repo/main.md' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    } as Partial<AppState>)

    store.getState().openFile({
      filePath: '/tmp/orca/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    expect(store.getState().activeFileId).toBe('/repo/main.md')
    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      '/tmp/orca/untitled.md'
    )
    expect(store.getState().activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('editor')
  })

  it('opens same-path floating markdown as a separate owner-qualified tab', () => {
    const store = createEditorStore()
    store.setState({
      openFiles: [
        {
          id: '/repo/README.md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        }
      ],
      activeFileIdByWorktree: { 'wt-1': '/repo/README.md' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    } as Partial<AppState>)

    store.getState().openFile(
      {
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    expect(store.getState().openFiles).toHaveLength(2)
    expect(store.getState().openFiles[0]).toMatchObject({
      filePath: '/repo/README.md',
      worktreeId: 'wt-1'
    })
    expect(store.getState().openFiles[1]).toMatchObject({
      filePath: '/repo/README.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null
    })
    expect(store.getState().openFiles[1]?.id).not.toBe('/repo/README.md')
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      store.getState().openFiles[1]?.id
    )
  })
})

describe('createEditorSlice untitled cleanup routing', () => {
  const runtimeEnvironmentCallMock = vi.fn()
  const runtimeEnvironmentTransportCallMock = vi.fn()
  const localDeletePathMock = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockReset()
    localDeletePathMock.mockReset()
    runtimeEnvironmentCallMock.mockResolvedValue({ ok: true, result: { deleted: true } })
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeEnvironmentTransportCallMock },
        fs: { deletePath: localDeletePathMock }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function seedRemoteWorktree(store: StoreApi<AppState>): void {
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [
        {
          id: 'repo1',
          path: '/remote/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0
        }
      ],
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/remote/wt',
            branch: 'refs/heads/main',
            head: 'abc',
            isBare: false,
            isMainWorktree: false,
            displayName: 'main',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 0
          }
        ]
      }
    } as Partial<AppState>)
  }

  it('closeFile deletes untouched remote untitled files through runtime file RPC', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().closeFile('/remote/wt/untitled.md')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: { worktree: 'wt-1', relativePath: 'untitled.md', recursive: undefined },
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeAllFiles deletes untouched remote untitled files through runtime file RPC', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().closeAllFiles()

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: { worktree: 'wt-1', relativePath: 'untitled.md', recursive: undefined },
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile uses relative remote delete when worktree metadata is missing', async () => {
    const store = createEditorStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().closeFile('/remote/wt/untitled.md')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: { worktree: 'wt-1', relativePath: 'untitled.md', recursive: undefined },
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile deletes untouched remote untitled files in their owning runtime after switching local', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })

    store.getState().closeFile('/remote/wt/untitled.md')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: { worktree: 'wt-1', relativePath: 'untitled.md', recursive: undefined },
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile deletes untouched remote untitled files in their owning runtime after switching environments', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-2' } as never })

    store.getState().closeFile('/remote/wt/untitled.md')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: { worktree: 'wt-1', relativePath: 'untitled.md', recursive: undefined },
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })
})

describe('createEditorSlice markdown view state', () => {
  it('updates stale language metadata when reopening an existing file', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/notebooks/example.ipynb',
      relativePath: 'notebooks/example.ipynb',
      worktreeId: 'wt-1',
      language: 'json',
      mode: 'edit'
    })

    store.getState().openFile({
      filePath: '/repo/notebooks/example.ipynb',
      relativePath: 'notebooks/example.ipynb',
      worktreeId: 'wt-1',
      language: 'notebook',
      mode: 'edit'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/notebooks/example.ipynb',
        language: 'notebook'
      })
    ])
  })

  it('drops markdown view mode for a replaced preview tab', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setMarkdownViewMode('/repo/docs/README.md', 'rich')

    store.getState().openFile(
      {
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().markdownViewMode).toEqual({})
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/docs/guide.md',
        isPreview: true
      })
    ])
  })
})

describe('createEditorSlice editor view mode', () => {
  it('stores changes mode as an explicit entry keyed by fileId', () => {
    const store = createEditorStore()

    store.getState().setEditorViewMode('/repo/app.ts', 'changes')

    expect(store.getState().editorViewMode).toEqual({ '/repo/app.ts': 'changes' })
  })

  it('deletes the entry when mode resets to edit', () => {
    const store = createEditorStore()
    store.getState().setEditorViewMode('/repo/app.ts', 'changes')

    store.getState().setEditorViewMode('/repo/app.ts', 'edit')

    expect(store.getState().editorViewMode).toEqual({})
  })

  it('is a no-op when resetting a file that was never in changes mode', () => {
    const store = createEditorStore()
    const before = store.getState().editorViewMode

    store.getState().setEditorViewMode('/repo/app.ts', 'edit')

    expect(store.getState().editorViewMode).toBe(before)
  })

  it('drops editor view mode when the file is closed', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/app.ts',
      relativePath: 'app.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorViewMode('/repo/app.ts', 'changes')

    store.getState().closeFile('/repo/app.ts')

    expect(store.getState().editorViewMode).toEqual({})
  })
})

describe('createEditorSlice openMarkdownPreview', () => {
  it('opens markdown preview as a separate read-only tab', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/docs/README.md',
        mode: 'edit'
      }),
      expect.objectContaining({
        id: 'markdown-preview::/repo/docs/README.md',
        mode: 'markdown-preview',
        markdownPreviewSourceFileId: '/repo/docs/README.md'
      })
    ])
    expect(store.getState().activeFileId).toBe('markdown-preview::/repo/docs/README.md')
  })

  it('retargets an existing preview tab instead of duplicating it', () => {
    const store = createEditorStore()

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown'
      },
      { anchor: 'install' }
    )

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'markdown-preview::/repo/docs/README.md',
        mode: 'markdown-preview',
        markdownPreviewAnchor: 'install'
      })
    ])
  })

  it('keeps preview-only same-path markdown previews separate by owner', () => {
    const store = createEditorStore()
    const floatingSourceId = ownedEditorFileId(
      '/repo/docs/README.md',
      FLOATING_TERMINAL_WORKTREE_ID,
      null
    )

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'README.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      language: 'markdown'
    })

    const previews = store.getState().openFiles.filter((file) => file.mode === 'markdown-preview')
    expect(previews).toEqual([
      expect.objectContaining({
        id: 'markdown-preview::/repo/docs/README.md',
        markdownPreviewSourceFileId: '/repo/docs/README.md',
        worktreeId: 'wt-1'
      }),
      expect.objectContaining({
        id: `markdown-preview::${floatingSourceId}`,
        markdownPreviewSourceFileId: floatingSourceId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ])
  })

  it('keeps same-path markdown previews separate by source owner', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const floatingFile = store
      .getState()
      .openFiles.find((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
    expect(floatingFile).toBeDefined()

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown'
      },
      { sourceFileId: floatingFile?.id }
    )

    const previews = store.getState().openFiles.filter((file) => file.mode === 'markdown-preview')
    expect(previews).toHaveLength(2)
    expect(previews.map((file) => file.markdownPreviewSourceFileId)).toEqual([
      '/repo/docs/README.md',
      floatingFile?.id
    ])
  })

  it('uses the resolved active runtime owner when opening markdown previews', () => {
    const store = createEditorStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-active' } as AppState['settings'],
      openFiles: [
        {
          id: '/repo/docs/README.md',
          filePath: '/repo/docs/README.md',
          relativePath: 'docs/README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        },
        {
          id: 'editor:wt-1:env-active:readme',
          filePath: '/repo/docs/README.md',
          relativePath: 'docs/README.md',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: 'env-active',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        }
      ]
    } as Partial<AppState>)

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })

    expect(store.getState().openFiles.at(-1)).toMatchObject({
      mode: 'markdown-preview',
      runtimeEnvironmentId: 'env-active',
      markdownPreviewSourceFileId: 'editor:wt-1:env-active:readme'
    })
  })
})

describe('createEditorSlice pending editor reveal', () => {
  it('stores the destination file path with the reveal payload', () => {
    const store = createEditorStore()

    store.getState().setPendingEditorReveal({
      filePath: '/repo/src/file.ts',
      line: 42,
      column: 7,
      matchLength: 5
    })

    expect(store.getState().pendingEditorReveal).toEqual({
      filePath: '/repo/src/file.ts',
      line: 42,
      column: 7,
      matchLength: 5
    })
  })

  it('clears pending reveal when closing all files in the active worktree', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setPendingEditorReveal({
      filePath: '/repo/src/file.ts',
      line: 42,
      column: 7,
      matchLength: 5
    })

    store.getState().closeAllFiles()

    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().pendingEditorReveal).toBeNull()
  })
})

describe('createEditorSlice editor drafts', () => {
  it('clears draft buffers when closing the file', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/src/file.ts', 'edited')

    store.getState().closeFile('/repo/src/file.ts')

    expect(store.getState().editorDrafts).toEqual({})
  })

  it('drops replaced preview drafts so hidden preview state cannot linger', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setEditorDraft('/repo/docs/README.md', 'draft')

    store.getState().openFile(
      {
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().editorDrafts).toEqual({})
  })

  it('falls back to a browser tab when closing the last editor in the active worktree', () => {
    const store = createEditorStore()

    store.setState({
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' }
    })

    store.getState().openFile({
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    store.getState().closeFile('/repo/src/file.ts')

    expect(store.getState().activeTabType).toBe('browser')
    expect(store.getState().activeBrowserTabId).toBe('browser-1')
  })

  it('returns to the landing state when closing the last editor in a worktree with no other surfaces', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().activeFileId).toBeNull()
    expect(store.getState().activeBrowserTabId).toBeNull()
    expect(store.getState().activeTabType).toBe('terminal')
  })

  it('falls back to a browser tab when closing all editors in the active worktree', () => {
    const store = createEditorStore()

    store.setState({
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' }
    })

    store.getState().openFile({
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    store.getState().closeAllFiles()

    expect(store.getState().activeTabType).toBe('browser')
    expect(store.getState().activeBrowserTabId).toBe('browser-1')
  })

  it('returns to the landing state when closing all editors and no other surfaces remain', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    store.getState().closeAllFiles()

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().activeFileId).toBeNull()
    expect(store.getState().activeBrowserTabId).toBeNull()
    expect(store.getState().activeTabType).toBe('terminal')
  })
})

describe('createEditorSlice conflict status reconciliation', () => {
  it('records clean git status checks with an explicit empty entry list', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-clean', {
      conflictOperation: 'unknown',
      entries: []
    })

    expect(store.getState().gitStatusByWorktree).toHaveProperty('wt-clean')
    expect(store.getState().gitStatusByWorktree['wt-clean']).toEqual([])
  })

  it('clears ignored path cache when status refresh omits ignored paths', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      ignoredPaths: ['dist/', '.env']
    })
    expect(store.getState().gitIgnoredPathsByWorktree['wt-1']).toEqual(['dist/', '.env'])

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: []
    })

    expect(store.getState().gitIgnoredPathsByWorktree['wt-1']).toEqual([])
  })

  it('tracks unresolved conflicts when opened through the conflict-safe entry point', () => {
    const store = createEditorStore()

    store.getState().openConflictFile(
      'wt-1',
      '/repo',
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved',
        conflictStatusSource: 'git'
      },
      'typescript'
    )
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [{ path: 'src/conflict.ts', status: 'modified', area: 'staged' }]
    })

    expect(store.getState().trackedConflictPathsByWorktree['wt-1']).toEqual({
      'src/conflict.ts': 'both_modified'
    })
    expect(store.getState().gitStatusByWorktree['wt-1']).toEqual([
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'staged',
        conflictKind: 'both_modified',
        conflictStatus: 'resolved_locally',
        conflictStatusSource: 'session'
      }
    ])
  })

  it('keeps the conflict review active when selecting a conflict from its tree', () => {
    const store = createEditorStore()

    store
      .getState()
      .openConflictReview(
        'wt-1',
        '/repo',
        [{ path: 'src/conflict.ts', conflictKind: 'both_modified' }],
        'live-summary'
      )
    store.getState().openConflictReviewFile(
      'wt-1::conflict-review',
      'wt-1',
      '/repo',
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved',
        conflictStatusSource: 'git'
      },
      'typescript'
    )

    const reviewFile = store
      .getState()
      .openFiles.find((file) => file.id === 'wt-1::conflict-review')

    expect(store.getState().activeFileId).toBe('wt-1::conflict-review')
    expect(reviewFile?.conflictReview?.selectedFileId).toBe('/repo/src/conflict.ts')
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: '/repo/src/conflict.ts',
        mode: 'edit',
        conflict: expect.objectContaining({ conflictStatus: 'unresolved' })
      })
    )
  })

  it('marks tracked conflicts as resolved locally after live conflict state disappears', () => {
    const store = createEditorStore()

    store.getState().trackConflictPath('wt-1', 'src/conflict.ts', 'both_modified')
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        }
      ]
    })
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [{ path: 'src/conflict.ts', status: 'modified', area: 'staged' }]
    })

    expect(store.getState().gitStatusByWorktree['wt-1']).toEqual([
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'staged',
        conflictKind: 'both_modified',
        conflictStatus: 'resolved_locally',
        conflictStatusSource: 'session'
      }
    ])
  })

  it('clears tracked conflict continuity on abort-like transitions', () => {
    const store = createEditorStore()

    store.getState().trackConflictPath('wt-1', 'src/conflict.ts', 'both_modified')
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        }
      ]
    })
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [{ path: 'src/conflict.ts', status: 'modified', area: 'unstaged' }]
    })

    expect(store.getState().gitStatusByWorktree['wt-1']).toEqual([
      { path: 'src/conflict.ts', status: 'modified', area: 'unstaged' }
    ])
    expect(store.getState().trackedConflictPathsByWorktree['wt-1']).toEqual({})
  })
})

describe('createEditorSlice combined diff exclusions', () => {
  it('stores skipped unresolved conflicts on combined diff tabs', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        },
        {
          path: 'src/normal.ts',
          status: 'modified',
          area: 'unstaged'
        }
      ]
    })
    store.getState().openAllDiffs('wt-1', '/repo')

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted',
        skippedConflicts: [{ path: 'src/conflict.ts', conflictKind: 'both_modified' }]
      })
    )
  })
})

describe('createEditorSlice remote branch actions', () => {
  const gitStatusMock = vi.fn()
  const gitUpstreamStatusMock = vi.fn()
  const gitPushMock = vi.fn()
  const gitPullMock = vi.fn()
  const gitFastForwardMock = vi.fn()
  const gitRebaseFromBaseMock = vi.fn()
  const gitFetchMock = vi.fn()

  beforeEach(() => {
    toastErrorMock.mockReset()
    gitStatusMock.mockReset()
    gitUpstreamStatusMock.mockReset()
    gitPushMock.mockReset()
    gitPullMock.mockReset()
    gitFastForwardMock.mockReset()
    gitRebaseFromBaseMock.mockReset()
    gitFetchMock.mockReset()

    gitStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    gitUpstreamStatusMock.mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 1,
      behind: 0
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window.api = {
      git: {
        status: gitStatusMock,
        upstreamStatus: gitUpstreamStatusMock,
        push: gitPushMock,
        pull: gitPullMock,
        fastForward: gitFastForwardMock,
        rebaseFromBase: gitRebaseFromBaseMock,
        fetch: gitFetchMock
      }
    }
  })

  it('stores upstream status per worktree', () => {
    const store = createEditorStore()

    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })

    expect(store.getState().remoteStatusesByWorktree['wt-1']).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })
  })

  it('does not notify subscribers when upstream status is unchanged', () => {
    const store = createEditorStore()
    const status = {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    }

    store.getState().setUpstreamStatus('wt-1', status)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.getState().setUpstreamStatus('wt-1', { ...status })
    unsubscribe()

    expect(listener).not.toHaveBeenCalled()
  })

  it('updates subscribers when explicit upstream status adds patch equivalence', () => {
    const store = createEditorStore()
    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3
    })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
    unsubscribe()

    expect(listener).toHaveBeenCalled()
    expect(store.getState().remoteStatusesByWorktree['wt-1']).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
  })

  it('runs pull and refreshes status + upstream on success', async () => {
    const store = createEditorStore()
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }]
    })

    await store.getState().pullBranch('wt-1', '/repo')

    expect(gitPullMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('runs rebase from base and refreshes upstream on success', async () => {
    const store = createEditorStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await store.getState().rebaseFromBase('wt-1', '/repo', 'origin/main', undefined, pushTarget)

    expect(gitRebaseFromBaseMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      baseRef: 'origin/main',
      connectionId: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('runs fast-forward and refreshes upstream on success', async () => {
    const store = createEditorStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await store.getState().fastForwardBranch('wt-1', '/repo', undefined, pushTarget)

    expect(gitFastForwardMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('surfaces a fast-forward toast and clears the busy flag when fast-forward fails', async () => {
    const store = createEditorStore()
    gitFastForwardMock.mockRejectedValueOnce(new Error('Not possible to fast-forward, aborting.'))

    await expect(store.getState().fastForwardBranch('wt-1', '/repo')).rejects.toThrow(
      'Not possible to fast-forward'
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Fast-forward failed. Not possible to fast-forward, aborting.'
    )
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('keeps fast-forward wording when normalized pull errors report local changes', async () => {
    const store = createEditorStore()
    gitFastForwardMock.mockRejectedValueOnce(
      new Error(
        'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
      )
    )

    await expect(store.getState().fastForwardBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Fast-forward blocked — commit or stash your local changes first.'
    )
  })

  it('keeps fast-forward wording when normalized pull errors report untracked files', async () => {
    const store = createEditorStore()
    gitFastForwardMock.mockRejectedValueOnce(
      new Error('Pull would overwrite untracked files. Move, remove, or add them before pulling.')
    )

    await expect(store.getState().fastForwardBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Fast-forward blocked — move, remove, or add untracked files first.'
    )
  })

  it('keeps rebase wording when normalized pull errors report local changes', async () => {
    const store = createEditorStore()
    gitRebaseFromBaseMock.mockRejectedValueOnce(
      new Error(
        'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
      )
    )

    await expect(store.getState().rebaseFromBase('wt-1', '/repo', 'origin/main')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Rebase blocked — commit or stash your local changes first.'
    )
  })

  it('keeps rebase wording when normalized pull errors report untracked files', async () => {
    const store = createEditorStore()
    gitRebaseFromBaseMock.mockRejectedValueOnce(
      new Error('Pull would overwrite untracked files. Move, remove, or add them before pulling.')
    )

    await expect(store.getState().rebaseFromBase('wt-1', '/repo', 'origin/main')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Rebase blocked — move, remove, or add untracked files first.'
    )
  })

  it('fetches the explicit push target and refreshes that target status', async () => {
    const store = createEditorStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await store.getState().fetchBranch('wt-1', '/repo', undefined, pushTarget)

    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('surfaces a readable toast when pull reports local changes would be overwritten', async () => {
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/app.ts\nPlease commit your changes or stash them before you merge.\nAborting'
      )
    )

    await expect(store.getState().pullBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Pull blocked — commit or stash your local changes first.'
    )
  })

  it('surfaces an explicit toast when pull stops on merge conflicts', async () => {
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'Auto-merging src/app.ts\nCONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.'
      )
    )

    await expect(store.getState().pullBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Pull stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
    )
  })

  it('runs publish branch through push with publish=true', async () => {
    // Why: pushBranch no longer awaits a post-op git status / upstream
    // refresh. The 3s git-status poll and the upstream-status effect in the
    // sidebar reconcile state shortly after the IPC returns; keeping the
    // mutation tight stops compound flows from stalling between commit and
    // push.
    const store = createEditorStore()

    await store.getState().pushBranch('wt-1', '/repo', true)

    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      publish: true,
      connectionId: undefined
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('preserves actionable publish errors and refreshes upstream after rejection', async () => {
    const store = createEditorStore()
    const publishError = new Error(
      'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    )
    gitPushMock.mockRejectedValueOnce(publishError)

    await expect(store.getState().pushBranch('wt-1', '/repo', true)).rejects.toThrow(
      publishError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
    await flushAsyncRemoteRefresh()

    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('maps publish updates-were-rejected into a clean actionable toast', async () => {
    const store = createEditorStore()
    const publishError = new Error(
      'Updates were rejected because the tip of your current branch is behind its remote counterpart.'
    )
    gitPushMock.mockRejectedValueOnce(publishError)

    await expect(store.getState().pushBranch('wt-1', '/repo', true)).rejects.toThrow(
      publishError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
    await flushAsyncRemoteRefresh()

    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('maps raw publish wrapper errors into a cleaner actionable toast', async () => {
    const store = createEditorStore()
    const rawPublishError = new Error(
      'git push failed: Command failed: git push --set-upstream origin feature-branch\nremote: Repository not found.\nfatal: Authentication failed for https://github.com/acme/private-repo.git'
    )
    gitPushMock.mockRejectedValueOnce(rawPublishError)

    await expect(store.getState().pushBranch('wt-1', '/repo', true)).rejects.toThrow(
      rawPublishError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Publish Branch failed. Authentication failed for https://github.com/acme/private-repo.git. Check your remote access and try again.'
    )
  })

  it('uses a fallback message for generic publish errors', async () => {
    const store = createEditorStore()
    const publishError = new Error('error: RPC failed; curl 56 GnuTLS recv error')
    gitPushMock.mockRejectedValueOnce(publishError)

    await expect(store.getState().pushBranch('wt-1', '/repo', true)).rejects.toThrow(
      publishError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Publish Branch failed. Check your remote access and try again.'
    )
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('maps non-fast-forward push errors into a clean actionable toast', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      'Updates were rejected because the tip of your current branch is behind its remote counterpart.'
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
    await flushAsyncRemoteRefresh()

    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('maps non-fast-forward keyword push errors into a clean actionable toast', async () => {
    const store = createEditorStore()
    const pushError = new Error('Push rejected: remote has newer commits (non-fast-forward).')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
    await flushAsyncRemoteRefresh()

    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('uses a fallback message for generic push errors', async () => {
    const store = createEditorStore()
    const pushError = new Error('network timeout')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith('Push failed. Check your connection and try again.')
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('uses a fallback remote failure message when push rejects without Error', async () => {
    const store = createEditorStore()
    gitPushMock.mockRejectedValueOnce('failure')

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toBe('failure')

    expect(toastErrorMock).toHaveBeenCalledWith('Remote operation failed')
  })

  it('runs fetchBranch and clears the busy flag on success', async () => {
    // Why: fetchBranch no longer awaits a post-op upstream refresh.
    // useGitStatusPolling and the sidebar's upstream effect handle the
    // reconcile, keeping the mutation focused on the single IPC.
    const store = createEditorStore()
    await store.getState().fetchBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(store.getState().isRemoteOperationActive).toBe(false)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('surfaces a toast and clears the busy flag when fetch fails', async () => {
    const store = createEditorStore()
    gitFetchMock.mockRejectedValueOnce(new Error('network timeout'))

    await expect(store.getState().fetchBranch('wt-1', '/repo')).rejects.toThrow('network timeout')

    expect(toastErrorMock).toHaveBeenCalledWith('Fetch failed. network timeout')
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('preserves prior upstream status when fetch fails', async () => {
    // Why: a transient upstream fetch failure (network blip, auth prompt
    // timeout) must not erase the last-known ahead/behind counts — doing so
    // would briefly flip the UI to an unknown/no-upstream state that
    // misrepresents the branch's relationship to its remote.
    const store = createEditorStore()
    store.getState().setUpstreamStatus('wt-1', {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })
    gitUpstreamStatusMock.mockRejectedValueOnce(new Error('transient failure'))

    await store.getState().fetchUpstreamStatus('wt-1', '/repo')

    expect(store.getState().remoteStatusesByWorktree['wt-1']).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
    })
  })

  it('keeps isRemoteOperationActive true while any remote op is in flight', async () => {
    // Why: a bare boolean races across worktrees — if push A finishes while
    // pull B is still running, flipping the flag off would prematurely
    // re-enable B's button. The refcount-derived boolean must stay true
    // until every in-flight remote op has finished.
    const store = createEditorStore()

    let resolveA: () => void = () => {}
    let resolveB: () => void = () => {}
    gitPushMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveA = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveB = resolve
          })
      )

    const pushA = store.getState().pushBranch('wt-1', '/a')
    // Kick microtasks so pushA has begun and flipped the flag on.
    await Promise.resolve()
    expect(store.getState().isRemoteOperationActive).toBe(true)

    const pushB = store.getState().pushBranch('wt-2', '/b')
    await Promise.resolve()
    expect(store.getState().isRemoteOperationActive).toBe(true)

    resolveA()
    await pushA.catch(() => {})
    // B is still running, so the busy flag must remain true.
    expect(store.getState().isRemoteOperationActive).toBe(true)

    resolveB()
    await pushB.catch(() => {})
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('runs syncBranch end-to-end (fetch+pull+push) on success', async () => {
    // Why: syncBranch no longer awaits a post-op git status / upstream
    // refresh. The polling layer reconciles state after the mutation
    // returns; the in-mutation upstream-status read remains because it
    // gates whether the inner push stage runs.
    const store = createEditorStore()

    await store.getState().syncBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(gitPullMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    // ahead=1 in the default mock, so sync pushes.
    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('skips the inner push when syncBranch sees ahead=0', async () => {
    // Why: guards against a no-op push round-trip after a pure fast-forward
    // pull. See syncBranch's ahead>0 guard in editor.ts.
    const store = createEditorStore()
    gitUpstreamStatusMock
      .mockResolvedValueOnce({
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 0,
        behind: 1
      })
      .mockResolvedValueOnce({
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 0,
        behind: 0
      })

    await store.getState().syncBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalled()
    expect(gitPullMock).toHaveBeenCalled()
    expect(gitPushMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('force-pushes with lease instead of pulling when sync sees a stale rebased upstream', async () => {
    const store = createEditorStore()
    gitUpstreamStatusMock.mockResolvedValueOnce({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })

    await store.getState().syncBranch('wt-1', '/repo')

    expect(gitFetchMock).toHaveBeenCalled()
    expect(gitPullMock).not.toHaveBeenCalled()
    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      forceWithLease: true
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledTimes(2)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('surfaces a sync-labeled toast when syncBranch inner push fails with auth error', async () => {
    // Why: the user invoked Sync — the toast must read "Sync failed..." even
    // though the underlying step is push. Detail extraction still surfaces
    // the actionable fatal/remote line so auth/protected-branch reasons stay
    // visible.
    const store = createEditorStore()
    const authError = new Error(
      'git push failed: Command failed: git push origin feature\nremote: Repository not found.\nfatal: Authentication failed for https://github.com/acme/private-repo.git'
    )
    gitPushMock.mockRejectedValueOnce(authError)

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow(authError.message)

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Sync failed. Authentication failed for https://github.com/acme/private-repo.git. Check your remote access and try again.'
    )
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('surfaces a single sync-labeled toast when syncBranch inner push is non-fast-forward', async () => {
    // Why: under sync, NFF means the remote raced ahead between fetch and
    // push — sync just pulled, so the bare "Pull first" guidance is wrong.
    // Surface a sync-shaped retry hint instead.
    const store = createEditorStore()
    const pushError = new Error(
      'Updates were rejected because the tip of your current branch is behind its remote counterpart.'
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow(pushError.message)

    // No double-toast from the outer catch.
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Sync failed — remote moved while syncing. Try again.'
    )
  })

  it('surfaces the pull-blocked toast when syncBranch pull stage fails', async () => {
    // Why: failures in sync's fetch/pull/status stages flow through the
    // outer catch's generic path; push-specific framing only applies to
    // the inner push stage.
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/app.ts\nPlease commit your changes or stash them before you merge.\nAborting'
      )
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Pull blocked — commit or stash your local changes first.'
    )
    expect(gitPushMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })

  it('surfaces a sync-labeled toast when syncBranch stops on merge conflicts', async () => {
    const store = createEditorStore()
    gitPullMock.mockRejectedValueOnce(
      new Error(
        'Auto-merging src/app.ts\nCONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.'
      )
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Sync stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
    )
    expect(gitPushMock).not.toHaveBeenCalled()
    expect(store.getState().isRemoteOperationActive).toBe(false)
  })
})

describe('createEditorSlice activateMarkdownLink', () => {
  const openUrlMock = vi.fn()
  const openFileUriMock = vi.fn()
  const pathExistsMock = vi.fn()
  const authorizeExternalPathMock = vi.fn()
  const fsStatMock = vi.fn()
  const runtimeEnvironmentCallMock = vi.fn()
  const runtimeEnvironmentTransportCallMock = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    toastErrorMock.mockReset()
    openUrlMock.mockReset()
    openFileUriMock.mockReset()
    pathExistsMock.mockReset()
    pathExistsMock.mockResolvedValue(true)
    authorizeExternalPathMock.mockReset()
    fsStatMock.mockReset()
    fsStatMock.mockImplementation(async ({ filePath }: { filePath: string }) => {
      const exists = await pathExistsMock(filePath)
      if (!exists) {
        throw new Error('File not found')
      }
      return { size: 1, isDirectory: false, mtime: 1 }
    })
    runtimeEnvironmentCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockReset()
    runtimeEnvironmentCallMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { size: 1, isDirectory: false, mtime: 1 },
      _meta: { runtimeId: 'runtime-source' }
    })
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args, 'runtime-source') ??
        runtimeEnvironmentCallMock(args)
    )
    openHttpLinkMock.mockReset()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window.api = {
      shell: {
        openUrl: openUrlMock,
        openFileUri: openFileUriMock,
        pathExists: pathExistsMock
      },
      fs: {
        authorizeExternalPath: authorizeExternalPathMock,
        stat: fsStatMock
      },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCallMock
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
      cb(0)
      return 0
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('opens in-worktree markdown links as preview edit tabs', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)

    await store.getState().activateMarkdownLink('./guide.md', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/docs/guide.md',
        mode: 'edit',
        isPreview: true
      })
    ])
    expect(openFileUriMock).not.toHaveBeenCalled()
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('opens remote-owned markdown links through the source file runtime owner', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-active' } as AppState['settings']
    })
    store.getState().openFile({
      filePath: '/repo/docs/note.md',
      relativePath: 'docs/note.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-source',
      language: 'markdown',
      mode: 'edit'
    })

    await store.getState().activateMarkdownLink('./guide.md', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
      selector: 'env-source',
      method: 'files.stat',
      params: { worktree: 'wt-1', relativePath: 'docs/guide.md' },
      timeoutMs: 15_000
    })
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/docs/note.md',
        runtimeEnvironmentId: 'env-source'
      }),
      expect.objectContaining({
        filePath: '/repo/docs/guide.md',
        runtimeEnvironmentId: 'env-source',
        mode: 'edit',
        isPreview: true
      })
    ])
  })

  it('stats SSH markdown links through the source worktree connection before opening', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/repo',
            branch: 'refs/heads/main',
            head: 'abc',
            isBare: false,
            isMainWorktree: true,
            displayName: 'main',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 0
          }
        ]
      }
    } as Partial<AppState>)

    await store.getState().activateMarkdownLink('./guide.md', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(fsStatMock).toHaveBeenCalledWith({
      filePath: '/repo/docs/guide.md',
      connectionId: 'ssh-1'
    })
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/docs/guide.md',
        mode: 'edit',
        isPreview: true
      })
    ])
  })

  it('does not open linked markdown directories as files', async () => {
    const store = createEditorStore()
    fsStatMock.mockResolvedValueOnce({ size: 1, isDirectory: true, mtime: 1 })

    await store.getState().activateMarkdownLink('./guide.md', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(store.getState().openFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith('Cannot open directory: docs/guide.md')
  })

  it('can open a local file without adopting the currently active runtime owner', () => {
    const store = createEditorStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-active' } as AppState['settings']
    })

    store.getState().openFile(
      {
        filePath: '/remote/.orca/drops/log.txt',
        relativePath: '.orca/drops/log.txt',
        worktreeId: 'wt-1',
        language: 'text',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    expect(store.getState().openFiles[0]).toMatchObject({
      filePath: '/remote/.orca/drops/log.txt'
    })
    expect(store.getState().openFiles[0]?.runtimeEnvironmentId).toBeNull()
  })

  it('toasts when the markdown target is missing', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(false)

    await store.getState().activateMarkdownLink('./missing.md', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(toastErrorMock).toHaveBeenCalledWith('File not found: docs/missing.md')
    expect(store.getState().openFiles).toEqual([])
    expect(openFileUriMock).not.toHaveBeenCalled()
  })

  it('sets source view mode when the link has a line anchor', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)

    await store.getState().activateMarkdownLink('./guide.md#L10', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(store.getState().markdownViewMode['/repo/docs/guide.md']).toBe('source')
    expect(store.getState().pendingEditorReveal).toEqual({
      filePath: '/repo/docs/guide.md',
      fileId: '/repo/docs/guide.md',
      line: 10,
      column: 1,
      matchLength: 0
    })
  })

  it('cancels superseded line-anchor reveal frames', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)
    let nextFrameId = 1
    const pendingFrames = new Map<number, FrameRequestCallback>()
    const canceledFrameIds = new Set<number>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const frameId = nextFrameId++
      pendingFrames.set(frameId, callback)
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
      canceledFrameIds.add(frameId)
      pendingFrames.delete(frameId)
    })

    await store.getState().activateMarkdownLink('./first.md#L3', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })
    await store.getState().activateMarkdownLink('./second.md#L9', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(canceledFrameIds).toContain(1)
    while (pendingFrames.size > 0) {
      const nextPendingFrame = pendingFrames.entries().next()
      if (nextPendingFrame.done) {
        break
      }
      const [frameId, callback] = nextPendingFrame.value
      pendingFrames.delete(frameId)
      callback(0)
    }
    expect(store.getState().pendingEditorReveal).toEqual({
      filePath: '/repo/docs/second.md',
      fileId: '/repo/docs/second.md',
      line: 9,
      column: 1,
      matchLength: 0
    })
  })

  it('reveals active-runtime markdown line anchors on the owner-qualified tab id', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-active' } as AppState['settings'],
      openFiles: [
        {
          id: '/repo/docs/guide.md',
          filePath: '/repo/docs/guide.md',
          relativePath: 'docs/guide.md',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: null,
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        }
      ]
    } as Partial<AppState>)
    const activeRuntimeFileId = ownedEditorFileId('/repo/docs/guide.md', 'wt-1', 'env-active')

    await store.getState().activateMarkdownLink('./guide.md#L10', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(store.getState().markdownViewMode[activeRuntimeFileId]).toBe('source')
    expect(store.getState().markdownViewMode['/repo/docs/guide.md']).toBeUndefined()
    expect(store.getState().pendingEditorReveal).toEqual({
      filePath: '/repo/docs/guide.md',
      fileId: activeRuntimeFileId,
      line: 10,
      column: 1,
      matchLength: 0
    })
  })

  it('sets line-anchor source mode on the owner-qualified target id', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)
    store.getState().openFile({
      filePath: '/repo/docs/note.md',
      relativePath: 'docs/note.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile(
      {
        filePath: '/repo/docs/note.md',
        relativePath: 'docs/note.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const floatingFileId = ownedEditorFileId(
      '/repo/docs/note.md',
      FLOATING_TERMINAL_WORKTREE_ID,
      null
    )

    await store.getState().activateMarkdownLink('./note.md#L3', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      worktreeRoot: '/repo',
      runtimeEnvironmentId: null
    })

    expect(store.getState().markdownViewMode[floatingFileId]).toBe('source')
    expect(store.getState().markdownViewMode['/repo/docs/note.md']).toBeUndefined()
    expect(store.getState().pendingEditorReveal).toEqual({
      filePath: '/repo/docs/note.md',
      fileId: floatingFileId,
      line: 3,
      column: 1,
      matchLength: 0
    })
  })

  it('delegates external links to openHttpLink with the ctx worktreeId', async () => {
    const store = createEditorStore()
    await store.getState().activateMarkdownLink('https://example.com', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })
    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/', { worktreeId: 'wt-1' })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(store.getState().openFiles).toEqual([])
  })

  it('opens in-worktree file links in Orca', async () => {
    const store = createEditorStore()
    await store.getState().activateMarkdownLink('./image.png', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/docs/image.png',
        relativePath: 'docs/image.png',
        mode: 'edit',
        isPreview: true
      })
    ])
    expect(openFileUriMock).not.toHaveBeenCalled()
  })

  it('reveals line targets for non-markdown file links', async () => {
    const store = createEditorStore()
    await store.getState().activateMarkdownLink('../src/PdfViewer.tsx:142:7', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/src/PdfViewer.tsx',
        relativePath: 'src/PdfViewer.tsx',
        mode: 'edit',
        isPreview: true
      })
    ])
    expect(store.getState().pendingEditorReveal).toEqual({
      filePath: '/repo/src/PdfViewer.tsx',
      fileId: '/repo/src/PdfViewer.tsx',
      line: 142,
      column: 7,
      matchLength: 0
    })
  })

  it('opens explicit file URLs inside the worktree in Orca', async () => {
    const store = createEditorStore()
    await store.getState().activateMarkdownLink('file:///repo/docs/image.png', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/docs/image.png',
        relativePath: 'docs/image.png',
        mode: 'edit',
        isPreview: true
      })
    ])
    expect(openFileUriMock).not.toHaveBeenCalled()
  })

  it('opens explicit file URLs outside the worktree in Orca after authorizing them', async () => {
    const store = createEditorStore()
    await store.getState().activateMarkdownLink('file:///tmp/image.png', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })
    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/image.png' })
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/tmp/image.png',
        relativePath: '/tmp/image.png',
        mode: 'edit',
        isPreview: true
      })
    ])
    expect(openFileUriMock).not.toHaveBeenCalled()
  })

  it('blocks external file URLs from SSH markdown sources', async () => {
    const store = createEditorStore()
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/repo',
            branch: 'refs/heads/main',
            head: 'abc',
            isBare: false,
            isMainWorktree: true,
            displayName: 'main',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 0
          }
        ]
      }
    } as Partial<AppState>)

    await store.getState().activateMarkdownLink('file:///tmp/image.png', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(store.getState().openFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
  })

  it('activates same-file line anchors via setActiveFile without opening a new tab', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)
    store.getState().openFile({
      filePath: '/repo/docs/note.md',
      relativePath: 'docs/note.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const openCountBefore = store.getState().openFiles.length

    await store.getState().activateMarkdownLink('./note.md#L3', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })

    expect(store.getState().openFiles).toHaveLength(openCountBefore)
    expect(store.getState().markdownViewMode['/repo/docs/note.md']).toBe('source')
    expect(store.getState().pendingEditorReveal?.line).toBe(3)
  })
})
