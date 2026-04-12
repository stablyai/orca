/* eslint-disable max-lines */

import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { createEditorSlice } from './editor'
import type { AppState } from '../types'

function createEditorStore(): StoreApi<AppState> {
  // Only the editor slice + activeWorktreeId are needed for these tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
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

describe('createEditorSlice markdown view state', () => {
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
})

describe('createEditorSlice conflict status reconciliation', () => {
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
