/* eslint-disable max-lines */

import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createEditorSlice } from './editor'
import type { AppState } from '../types'

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

describe('createEditorSlice remote branch actions', () => {
  const gitStatusMock = vi.fn()
  const gitUpstreamStatusMock = vi.fn()
  const gitPushMock = vi.fn()
  const gitPullMock = vi.fn()
  const gitFetchMock = vi.fn()

  beforeEach(() => {
    toastErrorMock.mockReset()
    gitStatusMock.mockReset()
    gitUpstreamStatusMock.mockReset()
    gitPushMock.mockReset()
    gitPullMock.mockReset()
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

  it('preserves actionable publish errors and avoids refresh on failure', async () => {
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
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
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
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
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
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
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
    expect(gitStatusMock).not.toHaveBeenCalled()
    expect(gitUpstreamStatusMock).not.toHaveBeenCalled()
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

    expect(toastErrorMock).toHaveBeenCalledWith('network timeout')
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
    gitUpstreamStatusMock.mockResolvedValueOnce({
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
})

describe('createEditorSlice activateMarkdownLink', () => {
  const openUrlMock = vi.fn()
  const openFileUriMock = vi.fn()
  const pathExistsMock = vi.fn()
  const authorizeExternalPathMock = vi.fn()

  beforeEach(() => {
    toastErrorMock.mockReset()
    openUrlMock.mockReset()
    openFileUriMock.mockReset()
    pathExistsMock.mockReset()
    authorizeExternalPathMock.mockReset()
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
        authorizeExternalPath: authorizeExternalPathMock
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
      cb(0)
      return 0
    }
  })

  afterEach(() => {
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

  it('sets source view mode before opening when the link has a line anchor', async () => {
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
      line: 10,
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
