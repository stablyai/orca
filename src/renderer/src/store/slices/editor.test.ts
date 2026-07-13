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
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitStatusEntry,
  Tab
} from '../../../../shared/types'
import { isSyncPushStageError } from '@/lib/source-control-remote-error'

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

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
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
    repos: [{ id: 'repo-1', path: '/repo' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
    folderWorkspaces: [],
    projectGroups: [],
    recordFeatureInteraction: vi.fn(),
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
    repos: [{ id: 'repo-1', path: '/repo' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
    folderWorkspaces: [],
    projectGroups: [],
    recordFeatureInteraction: vi.fn(),
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

function mirroredEditorUnifiedTab(id: string, entityId: string, worktreeId: string): Tab {
  return {
    id,
    entityId,
    worktreeId,
    groupId: `${worktreeId}:group`,
    contentType: 'editor',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('createEditorSlice right sidebar state', () => {
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

  it('keeps local and runtime-owned diffs in separate tabs for the same path', () => {
    const store = createEditorStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false, {
      runtimeEnvironmentId: 'env-1'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::file.ts',
        runtimeEnvironmentId: undefined
      }),
      expect.objectContaining({
        id: 'editor-diff:wt-1:env-1:unstaged:file.ts',
        runtimeEnvironmentId: 'env-1'
      })
    ])
  })

  it('derives a runtime owner for source-control diffs from the worktree host', () => {
    const store = createEditorStore()
    store.setState({
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-1' }] as unknown as AppState['repos'],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'repo-1::/srv/repo/worktree',
            repoId: 'repo-1',
            hostId: 'runtime:env-1'
          }
        ]
      } as unknown as AppState['worktreesByRepo']
    })

    store
      .getState()
      .openDiff(
        'repo-1::/srv/repo/worktree',
        '/srv/repo/worktree/src/file.ts',
        'src/file.ts',
        'typescript',
        false
      )

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'editor-diff:repo-1%3A%3A%2Fsrv%2Frepo%2Fworktree:env-1:unstaged:src%2Ffile.ts',
        runtimeEnvironmentId: 'env-1'
      })
    )
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

  it('bumps diffContentReloadNonce when re-opening an existing diff tab', () => {
    const store = createEditorStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    expect(store.getState().openFiles[0]?.diffContentReloadNonce).toBeUndefined()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    expect(store.getState().openFiles[0]?.diffContentReloadNonce).toBe(1)

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    expect(store.getState().openFiles[0]?.diffContentReloadNonce).toBe(2)
  })

  it('bumps fileContentReloadNonce when re-opening an existing clean file with reload requested', () => {
    const store = createEditorStore()

    const openFileWithReloadRequest = (): void =>
      store.getState().openFile(
        {
          filePath: '/repo/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit'
        },
        { forceContentReload: true }
      )

    openFileWithReloadRequest()
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBeUndefined()

    openFileWithReloadRequest()
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBe(1)

    openFileWithReloadRequest()
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBe(2)
  })

  it('does not bump fileContentReloadNonce when a dirty file is re-opened', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().markFileDirty('/repo/file.ts', true)

    store.getState().openFile(
      {
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { forceContentReload: true }
    )

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        isDirty: true,
        fileContentReloadNonce: undefined
      })
    )
  })

  it('opens the visible diff tab in the requested split group', () => {
    const store = createEditorTabsStore()
    const sourceTab = store.getState().createUnifiedTab('wt-1', 'terminal', { id: 'terminal-1' })
    const targetGroupId = store.getState().createEmptySplitGroup('wt-1', sourceTab.groupId, 'right')
    if (!targetGroupId) {
      throw new Error('expected split group')
    }

    store
      .getState()
      .openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false, { targetGroupId })

    const diffTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'diff')

    expect(diffTab?.groupId).toBe(targetGroupId)
    expect(diffTab?.entityId).toBe('wt-1::diff::unstaged::file.ts')
    expect(store.getState().activeGroupIdByWorktree['wt-1']).toBe(targetGroupId)
  })

  it('keeps a diff tab selectable after opening its target file tab', () => {
    const store = createEditorTabsStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    const diffFileId = 'wt-1::diff::unstaged::file.ts'
    const diffTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'diff')
    if (!diffTab) {
      throw new Error('expected diff tab')
    }

    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    const stateAfterOpen = store.getState()
    const editFile = stateAfterOpen.openFiles.find((file) => file.mode === 'edit')
    expect(stateAfterOpen.openFiles.find((file) => file.id === diffFileId)).toEqual(
      expect.objectContaining({ mode: 'diff' })
    )
    expect(editFile).toEqual(expect.objectContaining({ id: '/repo/file.ts', mode: 'edit' }))
    expect(
      stateAfterOpen.unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'editor')
        ?.entityId
    ).toBe('/repo/file.ts')

    store.getState().activateTab(diffTab.id)
    store.getState().setActiveFile(diffFileId)

    const stateAfterReselect = store.getState()
    expect(stateAfterReselect.groupsByWorktree['wt-1']?.[0]?.activeTabId).toBe(diffTab.id)
    expect(stateAfterReselect.activeFileId).toBe(diffFileId)
    expect(stateAfterReselect.openFiles.find((file) => file.id === diffFileId)?.mode).toBe('diff')
  })

  it('reuses a preview editor tab when opening a preview diff', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        filePath: '/repo/b.ts',
        isPreview: true,
        mode: 'diff'
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        contentType: 'diff',
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
  })

  it('keeps an existing preview replaceable when it is opened as preview again', () => {
    const store = createEditorTabsStore()

    const openPreviewFile = (): void =>
      store.getState().openFile(
        {
          filePath: '/repo/a.ts',
          relativePath: 'a.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit'
        },
        { preview: true }
      )

    openPreviewFile()
    openPreviewFile()

    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPreview: true
      })
    ])

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
  })

  it('does not orphan another split group when replacing a shared preview diff', () => {
    const store = createEditorTabsStore()

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, { preview: true })
    const firstGroupId = store.getState().groupsByWorktree['wt-1'][0].id
    const secondGroupId = store.getState().createEmptySplitGroup('wt-1', firstGroupId, 'right')

    expect(secondGroupId).toBeTruthy()

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, {
      preview: true,
      targetGroupId: secondGroupId ?? undefined
    })
    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, {
      preview: true,
      targetGroupId: secondGroupId ?? undefined
    })

    const state = store.getState()
    expect(state.openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::a.ts',
        isPreview: true
      }),
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(state.unifiedTabsByWorktree['wt-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: firstGroupId,
          entityId: 'wt-1::diff::unstaged::a.ts',
          isPreview: true
        }),
        expect.objectContaining({
          groupId: secondGroupId,
          entityId: 'wt-1::diff::unstaged::b.ts',
          isPreview: true
        })
      ])
    )
  })

  it('opens a new preview diff beside a pinned file tab', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().pinFile('/repo/a.ts')

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/a.ts',
        isPreview: undefined
      }),
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPinned: true,
        isPreview: false
      }),
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
  })

  it('makes a preview file permanent without pinning the tab', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().makePreviewFilePermanent('/repo/a.ts')

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/a.ts',
        isPreview: undefined
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPinned: undefined,
        isPreview: false
      })
    ])
  })

  it('does not replace a dirty file that was opened as a preview', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().markFileDirty('/repo/a.ts', true)

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/a.ts',
        isDirty: true,
        isPreview: undefined
      }),
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPreview: false
      }),
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
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

describe('createEditorSlice split-group editor routing', () => {
  function openSourceFile(
    store: StoreApi<AppState>,
    filePath: string,
    options?: Parameters<AppState['openFile']>[1]
  ): void {
    store.getState().openFile(
      {
        filePath,
        relativePath: filePath.replace('/repo/', ''),
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      options
    )
  }

  function seedTerminalAndEditorGroups(store: StoreApi<AppState>): {
    terminalTabId: string
    terminalGroupId: string
    editorGroupId: string
  } {
    const terminalTab = store.getState().createUnifiedTab('wt-1', 'terminal', {
      id: 'terminal-tab',
      entityId: 'terminal-tab',
      label: 'Agent'
    })
    const terminalGroup = store.getState().groupsByWorktree['wt-1']?.[0]
    if (!terminalGroup) {
      throw new Error('Expected terminal group')
    }
    const terminalGroupId = terminalGroup.id
    const editorGroupId = store.getState().createEmptySplitGroup('wt-1', terminalGroupId, 'right')
    if (!editorGroupId) {
      throw new Error('Expected split editor group')
    }
    openSourceFile(store, '/repo/seed.ts', { targetGroupId: editorGroupId })
    store.setState({
      activeGroupIdByWorktree: { 'wt-1': terminalGroupId },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-1': 'terminal' }
    } as Partial<AppState>)
    return { terminalTabId: terminalTab.id, terminalGroupId, editorGroupId }
  }

  function findUnifiedTabByEntity(store: StoreApi<AppState>, entityId: string) {
    return store.getState().unifiedTabsByWorktree['wt-1']?.find((tab) => tab.entityId === entityId)
  }

  it('routes implicit file opens to an existing visible editor group', () => {
    const store = createEditorTabsStore()
    const { terminalTabId, terminalGroupId, editorGroupId } = seedTerminalAndEditorGroups(store)

    openSourceFile(store, '/repo/next.ts')

    const openedTab = findUnifiedTabByEntity(store, '/repo/next.ts')
    const terminalGroup = store
      .getState()
      .groupsByWorktree['wt-1'].find((group) => group.id === terminalGroupId)
    const editorGroup = store
      .getState()
      .groupsByWorktree['wt-1'].find((group) => group.id === editorGroupId)
    expect(openedTab?.groupId).toBe(editorGroupId)
    expect(editorGroup?.activeTabId).toBe(openedTab?.id)
    expect(terminalGroup?.activeTabId).toBe(terminalTabId)
  })

  it('uses editor-recent groups when no inactive group is currently showing an editor', () => {
    const store = createEditorTabsStore()
    const { editorGroupId } = seedTerminalAndEditorGroups(store)
    store.getState().createUnifiedTab('wt-1', 'browser', {
      id: 'browser-tab',
      entityId: 'browser-tab',
      label: 'Browser',
      targetGroupId: editorGroupId
    })

    openSourceFile(store, '/repo/recent-target.ts')

    expect(findUnifiedTabByEntity(store, '/repo/recent-target.ts')?.groupId).toBe(editorGroupId)
  })

  it('keeps explicit target groups ahead of default editor routing', () => {
    const store = createEditorTabsStore()
    const { terminalGroupId } = seedTerminalAndEditorGroups(store)

    openSourceFile(store, '/repo/explicit.ts', { targetGroupId: terminalGroupId })

    expect(findUnifiedTabByEntity(store, '/repo/explicit.ts')?.groupId).toBe(terminalGroupId)
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
        params: { worktree: 'id:wt-1', relativePath: 'untitled.md', recursive: undefined },
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
        params: { worktree: 'id:wt-1', relativePath: 'untitled.md', recursive: undefined },
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
        params: { worktree: 'id:wt-1', relativePath: 'untitled.md', recursive: undefined },
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
        params: { worktree: 'id:wt-1', relativePath: 'untitled.md', recursive: undefined },
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
        params: { worktree: 'id:wt-1', relativePath: 'untitled.md', recursive: undefined },
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile keeps untouched templated untitled files on disk', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      deleteUntouchedOnClose: false,
      mode: 'edit'
    })

    store.getState().closeFile('/remote/wt/untitled.md')
    await flushAsyncRemoteRefresh()

    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
    expect(localDeletePathMock).not.toHaveBeenCalled()
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]).toMatchObject({
      filePath: '/remote/wt/untitled.md',
      deleteUntouchedOnClose: false
    })
  })

  it('closeAllFiles keeps untouched templated untitled files on disk', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      deleteUntouchedOnClose: false,
      mode: 'edit'
    })

    store.getState().closeAllFiles()
    await flushAsyncRemoteRefresh()

    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
    expect(localDeletePathMock).not.toHaveBeenCalled()
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]).toMatchObject({
      filePath: '/remote/wt/untitled.md',
      deleteUntouchedOnClose: false
    })
  })
})

describe('createEditorSlice recently closed editor tabs', () => {
  function openMirroredEditor(store: StoreApi<AppState>, filePath: string, preview = false): void {
    store.getState().openFile(
      {
        filePath,
        relativePath: filePath.replace('/repo/', ''),
        worktreeId: 'wt-1',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1',
        mirroredFromRuntimeSession: true,
        mode: 'edit'
      },
      { preview }
    )
  }

  it('reopens a closed mirrored editor tab as a local tab', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md')

    store.getState().closeFile('/repo/notes.md')

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles[0]).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('reopens close-all mirrored editor tabs as local tabs', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md')

    store.getState().closeAllFiles()

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles[0]).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('reopens replaced mirrored preview tabs as local tabs', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md', true)

    store.getState().openFile(
      {
        filePath: '/repo/guide.md',
        relativePath: 'guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1',
        mode: 'edit'
      },
      { preview: true, recordReplacedPreview: true }
    )

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles.at(-1)).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles.at(-1)).not.toHaveProperty('mirroredFromRuntimeSession')
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

  it('drops markdown visibility for a preview replaced by a diff', () => {
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
    store.getState().setMarkdownFrontmatterVisible('/repo/docs/README.md', false)
    store.getState().setMarkdownTableOfContentsVisible('/repo/docs/README.md', true)

    store.getState().openDiff('wt-1', '/repo/docs/guide.md', 'docs/guide.md', 'markdown', false, {
      preview: true
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })

  it('keeps markdown visibility when another preview still references a replaced source', () => {
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
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/docs/README.md', false)
    store.getState().setMarkdownTableOfContentsVisible('/repo/docs/README.md', true)

    store.getState().openDiff('wt-1', '/repo/docs/guide.md', 'docs/guide.md', 'markdown', false, {
      preview: true
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({
      '/repo/docs/README.md': false
    })
    expect(store.getState().markdownTableOfContentsVisible).toEqual({
      '/repo/docs/README.md': true
    })
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

describe('createEditorSlice markdown frontmatter visibility (#4468)', () => {
  it('stores hidden=false as an explicit entry keyed by fileId', () => {
    const store = createEditorStore()

    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    expect(store.getState().markdownFrontmatterVisible).toEqual({ '/repo/notes.md': false })
  })

  it('deletes the entry when visibility resets to visible', () => {
    const store = createEditorStore()
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', true)

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })

  it('is a no-op when showing a file that was never hidden', () => {
    const store = createEditorStore()
    const before = store.getState().markdownFrontmatterVisible

    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', true)

    expect(store.getState().markdownFrontmatterVisible).toBe(before)
  })

  it('drops the visibility flag when the file is closed', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })

  it('keeps the visibility flag while a preview tab still references the source file', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({ '/repo/notes.md': false })

    store.getState().closeFile('markdown-preview::/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })

  it('keeps the visibility flag when replacing an edit preview referenced by a markdown preview', () => {
    const store = createEditorStore()
    store.getState().openFile(
      {
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().openMarkdownPreview(
      {
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown'
      },
      { sourceFileId: '/repo/notes.md' }
    )
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().openFile(
      {
        filePath: '/repo/guide.md',
        relativePath: 'guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().markdownFrontmatterVisible).toEqual({ '/repo/notes.md': false })
  })

  it('drops the visibility flag when all files are closed', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().closeAllFiles()

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })
})

describe('createEditorSlice markdown table of contents visibility', () => {
  it('stores visible=true as an explicit entry keyed by fileId', () => {
    const store = createEditorStore()

    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    expect(store.getState().markdownTableOfContentsVisible).toEqual({ '/repo/notes.md': true })
  })

  it('deletes the entry when visibility resets to hidden', () => {
    const store = createEditorStore()
    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', false)

    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })

  it('drops the visibility flag when replacing a preview tab', () => {
    const store = createEditorStore()
    store.getState().openFile(
      {
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    store.getState().openFile(
      {
        filePath: '/repo/guide.md',
        relativePath: 'guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })

  it('keeps the visibility flag while a preview tab still references the source file', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().markdownTableOfContentsVisible).toEqual({ '/repo/notes.md': true })

    store.getState().closeFile('markdown-preview::/repo/notes.md')

    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
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

  it('treats a blank git status HEAD as unknown without invalidating branch compare', () => {
    const store = createEditorStore()
    const summary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-old',
      mergeBase: 'base-old',
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: summary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-clean', summary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-clean', {
      summary,
      entries: []
    })

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: '',
      branch: 'refs/heads/feature'
    })

    expect(store.getState().gitStatusHeadByWorktree['wt-1']).toBeUndefined()
    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(summary)
  })

  it('rejects a stale clean branch compare after git status reports a newer HEAD', () => {
    const store = createEditorStore()
    const cleanSummary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-old',
      mergeBase: 'base-old',
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }
    const updatedSummary = {
      ...cleanSummary,
      headOid: 'head-new',
      mergeBase: 'merge-new',
      changedFiles: 1,
      commitsAhead: 1
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: cleanSummary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-clean', cleanSummary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-clean', {
      summary: cleanSummary,
      entries: []
    })
    store
      .getState()
      .beginGitBranchCompareRequest(
        'wt-1',
        'req-refresh-before-head-change',
        cleanSummary.baseRef,
        { preserveExistingSummary: true }
      )

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: updatedSummary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-refresh-before-head-change', {
      summary: cleanSummary,
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual({
      baseRef: cleanSummary.baseRef,
      baseOid: null,
      compareRef: 'HEAD',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      status: 'loading'
    })
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([])
    expect(store.getState().gitBranchCompareRequestKeyByWorktree['wt-1']).toBe(
      'req-refresh-before-head-change'
    )

    store.getState().setGitBranchCompareResult('wt-1', 'req-refresh-before-head-change', {
      summary: updatedSummary,
      entries: [{ path: 'src/new.ts', status: 'modified' }]
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(updatedSummary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/new.ts', status: 'modified' }
    ])
  })

  it('rejects a stale unborn branch compare after git status reports a committed HEAD', () => {
    const store = createEditorStore()
    const unbornSummary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }
    const committedSummary = {
      ...unbornSummary,
      headOid: 'head-new',
      mergeBase: 'base-old',
      changedFiles: 1,
      commitsAhead: 1
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: '(initial)',
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-unborn', unbornSummary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-unborn', {
      summary: unbornSummary,
      entries: []
    })
    store
      .getState()
      .beginGitBranchCompareRequest('wt-1', 'req-before-first-commit', unbornSummary.baseRef, {
        preserveExistingSummary: true
      })

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: committedSummary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-before-first-commit', {
      summary: unbornSummary,
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual({
      baseRef: unbornSummary.baseRef,
      baseOid: null,
      compareRef: 'HEAD',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      status: 'loading'
    })

    store.getState().setGitBranchCompareResult('wt-1', 'req-before-first-commit', {
      summary: committedSummary,
      entries: [{ path: 'src/first.ts', status: 'added' }]
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(committedSummary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/first.ts', status: 'added' }
    ])
  })

  it('accepts an unborn branch compare when git status reports the initial branch marker', () => {
    const store = createEditorStore()
    const unbornSummary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }

    store.getState().beginGitBranchCompareRequest('wt-1', 'req-unborn', unbornSummary.baseRef)
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: '(initial)',
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-unborn', {
      summary: unbornSummary,
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(unbornSummary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([])
  })

  it('keeps loading branch compare state when an older HEAD result arrives', () => {
    const store = createEditorStore()

    store.getState().beginGitBranchCompareRequest('wt-1', 'req-stale', 'refs/remotes/origin/main')
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-new',
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-stale', {
      summary: {
        baseRef: 'refs/remotes/origin/main',
        baseOid: 'base-old',
        compareRef: 'feature',
        headOid: 'head-old',
        mergeBase: 'base-old',
        changedFiles: 0,
        commitsAhead: 0,
        status: 'ready'
      },
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual({
      baseRef: 'refs/remotes/origin/main',
      baseOid: null,
      compareRef: 'HEAD',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      status: 'loading'
    })
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toBeUndefined()
  })

  it('accepts a newer branch compare before git status catches up', () => {
    const store = createEditorStore()
    const summary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-new',
      mergeBase: 'base-old',
      changedFiles: 1,
      commitsAhead: 1,
      status: 'ready' as const
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-old',
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-newer', summary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-newer', {
      summary,
      entries: [{ path: 'src/new.ts', status: 'modified' }]
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(summary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/new.ts', status: 'modified' }
    ])
  })

  it('preserves a newer branch compare when an unchanged older status refresh returns', () => {
    const store = createEditorStore()
    const summary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-new',
      mergeBase: 'base-old',
      changedFiles: 1,
      commitsAhead: 1,
      status: 'ready' as const
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-old',
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-newer', summary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-newer', {
      summary,
      entries: [{ path: 'src/new.ts', status: 'modified' }]
    })
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-old',
      branch: 'refs/heads/feature'
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(summary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/new.ts', status: 'modified' }
    ])
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

  it('reloads an open check-details tab from the hosted provider', async () => {
    const fetchPRCheckDetails = vi.fn().mockResolvedValue({
      name: 'verify',
      status: 'completed',
      conclusion: 'success',
      url: null,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
      title: 'Build passed',
      summary: null,
      text: null,
      annotations: [],
      jobs: []
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = createStore<any>()((...args: any[]) => ({
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
      fetchPRCheckDetails,
      ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
    })) as unknown as StoreApi<AppState>
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null
    })

    await store.getState().reloadOpenCheckRunDetailsTab('wt-1::check-details::check-run:42')

    expect(fetchPRCheckDetails).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ checkRunId: 42, checkName: 'verify' }),
      { repoId: 'repo-1' }
    )
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::check-run:42',
        checkRunDetails: expect.objectContaining({
          loading: false,
          details: expect.objectContaining({ title: 'Build passed', conclusion: 'success' })
        })
      })
    )
  })

  it('patches an open check-details tab without changing the active file', () => {
    const store = createEditorTabsStore()
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: true,
      error: null
    })
    store.getState().openFile({
      filePath: '/repo/other.ts',
      relativePath: 'other.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      details: {
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        title: 'Build failed',
        summary: null,
        text: null,
        annotations: [],
        jobs: []
      },
      loading: false,
      error: null
    })

    expect(store.getState().activeFileId).toBe('/repo/other.ts')
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::check-run:42',
        checkRunDetails: expect.objectContaining({
          loading: false,
          details: expect.objectContaining({ title: 'Build failed' })
        })
      })
    )
  })

  it('opens check full details as a center-pane editor tab', () => {
    const store = createEditorTabsStore()
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: {
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        title: 'Build failed',
        summary: null,
        text: null,
        annotations: [],
        jobs: []
      },
      loading: false,
      error: null
    })

    expect(store.getState().activeFileId).toBe('wt-1::check-details::check-run:42')
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::check-run:42',
        mode: 'check-details',
        relativePath: 'verify',
        checkRunDetails: expect.objectContaining({
          contextKey: 'repo:99',
          check,
          details: expect.objectContaining({ title: 'Build failed' })
        })
      })
    )
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({
        entityId: 'wt-1::check-details::check-run:42',
        contentType: 'check-details',
        label: 'verify'
      })
    )
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

  it('uses a supplied combined diff entry snapshot instead of the whole area', () => {
    const store = createEditorStore()
    const normalEntry: GitStatusEntry = {
      path: 'src/normal.ts',
      status: 'modified',
      area: 'unstaged'
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/resolved.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'resolved_locally'
        },
        normalEntry
      ]
    })
    store.getState().openAllDiffs('wt-1', '/repo', undefined, 'unstaged', [normalEntry])

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted::unstaged',
        uncommittedEntriesSnapshot: [normalEntry],
        skippedConflicts: []
      })
    )
  })

  it('includes untracked files in the all changes snapshot', () => {
    const store = createEditorStore()
    const stagedEntry: GitStatusEntry = {
      path: 'src/staged.ts',
      status: 'modified',
      area: 'staged'
    }
    const untrackedEntry: GitStatusEntry = {
      path: 'src/new.ts',
      status: 'untracked',
      area: 'untracked'
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [stagedEntry, untrackedEntry]
    })
    store.getState().openAllDiffs('wt-1', '/repo')

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted',
        uncommittedEntriesSnapshot: [stagedEntry, untrackedEntry]
      })
    )
  })

  it('opens all changes with uncommitted and committed branch snapshots', () => {
    const store = createEditorStore()
    const localEntry: GitStatusEntry = {
      path: 'src/local.ts',
      status: 'modified',
      area: 'unstaged'
    }
    const branchEntry: GitBranchChangeEntry = {
      path: 'src/committed.ts',
      status: 'modified'
    }
    const branchSummary: GitBranchCompareSummary = {
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      compareRef: 'HEAD',
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      changedFiles: 1,
      status: 'ready'
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [localEntry]
    })
    store.setState({
      gitBranchCompareSummaryByWorktree: { 'wt-1': branchSummary },
      gitBranchChangesByWorktree: { 'wt-1': [branchEntry] }
    })
    store.getState().openAllDiffs('wt-1', '/repo')

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted',
        diffSource: 'combined-all',
        uncommittedEntriesSnapshot: [localEntry],
        branchEntriesSnapshot: [branchEntry],
        branchCompare: expect.objectContaining({
          baseRef: 'origin/main',
          baseOid: 'base-oid',
          headOid: 'head-oid',
          mergeBase: 'merge-base-oid'
        })
      })
    )
  })
})

describe('createEditorSlice openBranchDiff', () => {
  it('derives a runtime owner for branch diffs from the worktree host', () => {
    const store = createEditorStore()
    const worktreeId = 'repo-1::/srv/repo/worktree'
    const branchSummary: GitBranchCompareSummary = {
      baseRef: 'main',
      baseOid: 'base-oid',
      compareRef: 'HEAD',
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      changedFiles: 1,
      status: 'ready'
    }
    store.setState({
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-1' }] as unknown as AppState['repos'],
      worktreesByRepo: {
        'repo-1': [{ id: worktreeId, repoId: 'repo-1', hostId: 'runtime:env-1' }]
      } as unknown as AppState['worktreesByRepo']
    })

    store
      .getState()
      .openBranchDiff(
        worktreeId,
        '/srv/repo/worktree',
        { path: 'src/file.ts', status: 'modified' },
        branchSummary,
        'typescript'
      )

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        diffSource: 'branch',
        filePath: '/srv/repo/worktree/src/file.ts',
        runtimeEnvironmentId: 'env-1'
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

  it('routes git operations through the explicit runtime owner instead of ambient focus', async () => {
    const store = createEditorStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as never })

    await store.getState().pushBranch('wt-1', '/repo', false, undefined, undefined, {
      runtimeTargetSettings: { activeRuntimeEnvironmentId: null }
    })

    expect(gitPushMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      publish: false,
      connectionId: undefined,
      pushTarget: undefined,
      forceWithLease: undefined
    })
    expect(gitUpstreamStatusMock).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget: undefined
    })
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

  it('surfaces submodule push failures with the submodule name', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "Command failed: git push\nPushing submodule 'find-cmux-followers'\n" +
        ' ! [rejected]        master -> master (fetch first)\n' +
        "Unable to push submodule 'find-cmux-followers'\n" +
        'fatal: failed to push all needed submodules'
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      "Push failed. Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
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

  it('surfaces transport-prefixed normalized submodule push failures', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "Error invoking remote method 'git:push': Error: Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith(
      "Push failed. Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
    )
    await flushAsyncRemoteRefresh()

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

  it('maps pre-push hook failures to hook-specific guidance instead of remote access', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "git push failed: Command failed: git push origin main\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1\neslint found 2 errors"
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(store.getState().pushBranch('wt-1', '/repo', false)).rejects.toThrow(
      pushError.message
    )

    expect(toastErrorMock).toHaveBeenCalledWith('Push blocked — lint failed during push.')
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

  it('maps force-with-lease rejection into force-push guidance', async () => {
    const store = createEditorStore()
    const pushError = new Error('fatal: stale info')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(
      store.getState().pushBranch('wt-1', '/repo', false, undefined, undefined, {
        forceWithLease: true
      })
    ).rejects.toThrow(pushError.message)

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
    )
    await flushAsyncRemoteRefresh()

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

  it('uses a force-push fallback message for generic force-with-lease errors', async () => {
    const store = createEditorStore()
    const pushError = new Error('network timeout')
    gitPushMock.mockRejectedValueOnce(pushError)

    await expect(
      store.getState().pushBranch('wt-1', '/repo', false, undefined, undefined, {
        forceWithLease: true
      })
    ).rejects.toThrow(pushError.message)

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Force Push failed. Check your connection and try again.'
    )
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

  it('marks syncBranch inner push hook failures as sync push-stage failures', async () => {
    const store = createEditorStore()
    const pushError = new Error(
      "git push failed: Command failed: git push origin feature\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1"
    )
    gitPushMock.mockRejectedValueOnce(pushError)

    let thrown: unknown
    try {
      await store.getState().syncBranch('wt-1', '/repo')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(pushError)
    expect(isSyncPushStageError(thrown)).toBe(true)
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('Sync blocked — pre-push hook failed.')
  })

  it('does not classify syncBranch fetch-stage hook-looking failures as push blocked', async () => {
    const store = createEditorStore()
    gitFetchMock.mockRejectedValueOnce(
      new Error('fetch failed before push\npre-push hook docs mention eslint')
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('Sync failed. Check your connection and try again.')
    expect(gitPushMock).not.toHaveBeenCalled()
  })

  it('does not classify syncBranch upstream-status hook-looking failures as push blocked', async () => {
    const store = createEditorStore()
    gitUpstreamStatusMock.mockRejectedValueOnce(
      new Error('upstream status failed before push\npre-push hook docs mention eslint')
    )

    await expect(store.getState().syncBranch('wt-1', '/repo')).rejects.toThrow()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('Sync failed. Check your connection and try again.')
    expect(gitPushMock).not.toHaveBeenCalled()
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
      params: { worktree: 'id:wt-1', relativePath: 'docs/guide.md' },
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

  it('rejects ambiguous same-path owner fallback and honors an explicit source owner', async () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/docs/note.md',
      relativePath: 'docs/note.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-source',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile(
      {
        filePath: '/repo/docs/note.md',
        relativePath: 'docs/note.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    await store.getState().activateMarkdownLink('https://example.com', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo'
    })
    expect(openHttpLinkMock).not.toHaveBeenCalled()

    await store.getState().activateMarkdownLink('https://example.com', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    })
    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' }
    })
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
    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' }
    })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(store.getState().openFiles).toEqual([])
  })

  it('does not rescan legacy owner state when the source owner is explicit', async () => {
    const store = createEditorStore()
    for (const key of ['openFiles', 'repos', 'worktreesByRepo', 'folderWorkspaces'] as const) {
      Object.defineProperty(store.getState(), key, {
        configurable: true,
        get: () => {
          throw new Error(`explicit owner must not read ${key}`)
        }
      })
    }

    await store.getState().activateMarkdownLink('https://example.com', {
      sourceFilePath: '/repo/docs/note.md',
      worktreeId: 'wt-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    })

    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' }
    })
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

describe('closeFile host mirroring', () => {
  beforeEach(() => {
    notifyHostOfMirroredEditorCloseMock.mockReset()
  })

  it('routes every close through the host-mirror notifier and still removes the file locally', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const fileId = store.getState().openFiles[0]!.id

    store.getState().closeFile(fileId)

    // Why: closeFile is the single chokepoint, so a mirrored tab closed via any
    // surface (tab strip, bulk close, save/discard) reaches the host. The notifier
    // itself no-ops for non-mirrored files; here we assert the wiring + local close.
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(
      expect.anything(),
      'wt-1',
      fileId
    )
    expect(store.getState().openFiles).toHaveLength(0)
  })

  it('notifies the host for mirrored editors removed by close all in the active worktree', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    store.getState().openFile({
      filePath: '/other/b.ts',
      relativePath: 'b.ts',
      worktreeId: 'wt-2',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    store.setState({
      unifiedTabsByWorktree: {
        'wt-1': [mirroredEditorUnifiedTab('host-tab-a', '/repo/a.ts', 'wt-1')],
        'wt-2': [mirroredEditorUnifiedTab('host-tab-b', '/other/b.ts', 'wt-2')]
      },
      tabBarOrderByWorktree: {
        'wt-1': ['host-tab-a'],
        'wt-2': ['host-tab-b']
      }
    } as Partial<AppState>)

    store.getState().closeAllFiles()

    // Why: closeAllFiles mutates openFiles directly instead of calling closeFile,
    // so it must still run the host close hook for every removed mirrored editor.
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledTimes(1)
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(
      expect.anything(),
      'wt-1',
      '/repo/a.ts'
    )
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.id).toBe('/other/b.ts')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([])
    expect(store.getState().tabBarOrderByWorktree['wt-2']).toEqual(['host-tab-b'])
  })

  it('notifies the host for every mirrored editor when close all has no active worktree', () => {
    const store = createEditorTabsStore()
    store.setState({ activeWorktreeId: null })
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    store.getState().openFile({
      filePath: '/other/b.ts',
      relativePath: 'b.ts',
      worktreeId: 'wt-2',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    store.setState({
      unifiedTabsByWorktree: {
        'wt-1': [mirroredEditorUnifiedTab('host-tab-a', '/repo/a.ts', 'wt-1')],
        'wt-2': [mirroredEditorUnifiedTab('host-tab-b', '/other/b.ts', 'wt-2')]
      },
      tabBarOrderByWorktree: {
        'wt-1': ['host-tab-a'],
        'wt-2': ['host-tab-b']
      }
    } as Partial<AppState>)

    store.getState().closeAllFiles()

    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledTimes(2)
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(
      expect.anything(),
      'wt-1',
      '/repo/a.ts'
    )
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(
      expect.anything(),
      'wt-2',
      '/other/b.ts'
    )
    expect(store.getState().openFiles).toHaveLength(0)
  })
})

describe('read-only editor tabs (AI Vault View Log)', () => {
  const LOG_PATH = '/home/user/.claude/sessions/log.jsonl'

  const openReadOnlyLog = (store: StoreApi<AppState>): void =>
    store.getState().openFile(
      {
        filePath: LOG_PATH,
        relativePath: LOG_PATH,
        worktreeId: 'wt-1',
        language: 'jsonl',
        mode: 'edit',
        readOnly: true,
        liveTail: true,
        runtimeEnvironmentId: null
      },
      { preview: false, forceContentReload: true, suppressActiveRuntimeFallback: true }
    )

  it('creates a permanent read-only edit tab', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        filePath: LOG_PATH,
        mode: 'edit',
        readOnly: true,
        liveTail: true,
        isPreview: undefined,
        runtimeEnvironmentId: null
      })
    )
  })

  it('bumps the reload nonce on repeated View Log of a clean read-only tab', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBeUndefined()

    openReadOnlyLog(store)
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBe(1)
  })

  it('keeps read-only sticky when the same path is opened writable (no silent upgrade)', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)

    store.getState().openFile({
      filePath: LOG_PATH,
      relativePath: LOG_PATH,
      worktreeId: 'wt-1',
      language: 'jsonl',
      mode: 'edit',
      runtimeEnvironmentId: null
    })

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.readOnly).toBe(true)
  })

  it('never flips an existing writable tab to read-only on View Log', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: LOG_PATH,
      relativePath: LOG_PATH,
      worktreeId: 'wt-1',
      language: 'jsonl',
      mode: 'edit',
      runtimeEnvironmentId: null
    })

    openReadOnlyLog(store)

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.readOnly).toBeUndefined()
  })

  it('markFileDirty and setEditorDraft hard no-op for read-only tabs', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)

    store.getState().markFileDirty(LOG_PATH, true)
    store.getState().setEditorDraft(LOG_PATH, 'stray edit')

    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    expect(store.getState().editorDrafts[LOG_PATH]).toBeUndefined()
  })

  it('hydrates a persisted read-only tab clean and ignores any persisted dirty draft', () => {
    const store = createEditorStore()
    store.setState({
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1' }] },
      folderWorkspaces: []
    } as never)

    store.getState().hydrateEditorSession({
      openFilesByWorktree: {
        'wt-1': [
          {
            filePath: LOG_PATH,
            relativePath: LOG_PATH,
            worktreeId: 'wt-1',
            language: 'jsonl',
            readOnly: true,
            liveTail: true,
            // Why: a corrupt/legacy session could carry a draft; hydrate must
            // hard-strip it so the restored log can never come back writable.
            dirtyDraftContent: 'should be ignored',
            lastKnownDiskSignature: 'sig'
          }
        ]
      }
    } as never)

    const restored = store.getState().openFiles.find((f) => f.filePath === LOG_PATH)
    expect(restored).toEqual(
      expect.objectContaining({ readOnly: true, liveTail: true, isDirty: false, mode: 'edit' })
    )
    expect(restored?.pendingDiskBaselineVerification).toBeUndefined()
    expect(store.getState().editorDrafts[LOG_PATH]).toBeUndefined()
  })
})
