import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createEditorStore, createEditorTabsStore } from '../editor-slice-test-harness'

import type { Tab } from '../../../../../../shared/tab-types'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/web-session-tabs-sync/closing/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

// Why: tabs are mirrored only from a paired server's workspace, which keeps today's close path.
const pairedServerWorktrees = {
  'repo-1': [
    makeWorktree({
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/repo',
      runtimeOwnerEnvironmentId: 'env-1'
    }),
    makeWorktree({
      id: 'wt-2',
      repoId: 'repo-1',
      path: '/other',
      runtimeOwnerEnvironmentId: 'env-1'
    })
  ]
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

describe('createEditorSlice editor drafts', () => {
  it('preserves the foreground reveal when a background preview record was already replaced', () => {
    const store = createEditorTabsStore()
    store.getState().createUnifiedTab('wt-2', 'diff', {
      id: 'old-preview',
      entityId: 'removed-content',
      isPreview: true,
      activate: false,
      executionHostId: 'local'
    })
    const reveal = { filePath: '/repo/next.ts', line: 7, column: 3, matchLength: 4 }
    store.setState({ pendingEditorReveal: reveal })

    store.getState().createUnifiedTab('wt-2', 'diff', {
      id: 'new-preview',
      entityId: 'new-content',
      isPreview: true,
      activate: false,
      executionHostId: 'local'
    })

    expect(store.getState().pendingEditorReveal).toBe(reveal)
    expect(store.getState().activeWorktreeId).toBe('wt-1')
    expect(store.getState().unifiedTabsByWorktree['wt-2']?.map((tab) => tab.id)).toEqual([
      'new-preview'
    ])
  })

  it('drops replaced preview drafts so hidden preview state cannot linger', () => {
    const store = createEditorTabsStore()

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
})

describe('closeFile host mirroring', () => {
  beforeEach(() => {
    notifyHostOfMirroredEditorCloseMock.mockReset()
  })

  it('notifies the host for mirrored editors removed by close all in the active worktree', () => {
    const store = createEditorTabsStore()
    store.setState({ worktreesByRepo: pairedServerWorktrees })
    const a = store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    const b = store.getState().openFile({
      filePath: '/other/b.ts',
      relativePath: 'b.ts',
      worktreeId: 'wt-2',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    store.setState({
      unifiedTabsByWorktree: {
        'wt-1': [mirroredEditorUnifiedTab('host-tab-a', a, 'wt-1')],
        'wt-2': [mirroredEditorUnifiedTab('host-tab-b', b, 'wt-2')]
      },
      tabBarOrderByWorktree: {
        'wt-1': ['host-tab-a'],
        'wt-2': ['host-tab-b']
      }
    })

    store.getState().closeAllFiles()

    // closeAllFiles bypasses closeFile; require host close hooks for every directly removed mirror.
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(expect.anything(), 'wt-1', a)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.id).toBe(b)
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([])
    expect(store.getState().tabBarOrderByWorktree['wt-2']).toEqual(['host-tab-b'])
  })
})
