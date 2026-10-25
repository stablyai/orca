import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  createEditorStore,
  createEditorTabsStore,
  flushAsyncRemoteRefresh
} from './editor-slice-test-harness'
import type { AppState } from '../types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import type { Tab } from '../../../../shared/tab-types'
import { makeWorktree } from './store-test-helpers'

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

describe('createEditorSlice untitled cleanup routing', () => {
  const runtimeEnvironmentCallMock = vi.fn()
  const runtimeEnvironmentTransportCallMock = vi.fn()
  const localDeletePathMock = vi.fn()
  let remoteUntitledFileSize = 0

  beforeEach(() => {
    remoteUntitledFileSize = 0
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockReset()
    localDeletePathMock.mockReset()
    runtimeEnvironmentCallMock.mockImplementation(async (args: RuntimeEnvironmentCallRequest) =>
      args.method === 'files.stat'
        ? { ok: true, result: { size: remoteUntitledFileSize, isDirectory: false, mtime: 0 } }
        : { ok: true, result: { deleted: true } }
    )
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
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
      repos: [
        {
          id: 'repo1',
          path: '/remote/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0,
          // Server rows are stamped as they land; focus alone never owns a write.
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            hostId: 'runtime:env-1',
            runtimeOwnerEnvironmentId: 'env-1',
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
    })
  }

  it('closeFile deletes untouched remote untitled files through runtime file RPC', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    const fileId = store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().closeFile(fileId)

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: {
          worktree: 'id:wt-1',
          relativePath: 'untitled.md',
          recursive: undefined,
          expectedExecutionHostId: 'local'
        },
        expectedEnvironmentPairingRevision: undefined,
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
        params: {
          worktree: 'id:wt-1',
          relativePath: 'untitled.md',
          recursive: undefined,
          expectedExecutionHostId: 'local'
        },
        expectedEnvironmentPairingRevision: undefined,
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile keeps an untouched remote untitled file that something else wrote into', async () => {
    remoteUntitledFileSize = 42
    const store = createEditorStore()
    seedRemoteWorktree(store)
    const fileId = store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().closeFile(fileId)

    await vi.waitFor(() =>
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'files.stat' })
      )
    )
    // Why: a macrotask drains the whole stat → cleanup microtask chain, however many hops the runtime client adds.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.delete' })
    )
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile does not delete when worktree ownership metadata is missing', async () => {
    const store = createEditorStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
      repos: [],
      worktreesByRepo: {}
    })
    const fileId = store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().closeFile(fileId)

    await flushAsyncRemoteRefresh()

    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile deletes untouched remote untitled files in their owning runtime after switching local', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    const fileId = store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })

    store.getState().closeFile(fileId)

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: {
          worktree: 'id:wt-1',
          relativePath: 'untitled.md',
          recursive: undefined,
          expectedExecutionHostId: 'local'
        },
        expectedEnvironmentPairingRevision: undefined,
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile deletes untouched remote untitled files in their owning runtime after switching environments', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    const fileId = store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-2' } as never })

    store.getState().closeFile(fileId)

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: {
          worktree: 'id:wt-1',
          relativePath: 'untitled.md',
          recursive: undefined,
          expectedExecutionHostId: 'local'
        },
        expectedEnvironmentPairingRevision: undefined,
        timeoutMs: 15_000
      })
    })
    expect(localDeletePathMock).not.toHaveBeenCalled()
  })

  it('closeFile keeps untouched templated untitled files on disk', async () => {
    const store = createEditorStore()
    seedRemoteWorktree(store)
    const fileId = store.getState().openFile({
      filePath: '/remote/wt/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      deleteUntouchedOnClose: false,
      mode: 'edit'
    })

    store.getState().closeFile(fileId)
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

    // Why: closeAllFiles mutates openFiles directly instead of calling closeFile,
    // so it must still run the host close hook for every removed mirrored editor.
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledTimes(1)
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(expect.anything(), 'wt-1', a)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.id).toBe(b)
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([])
    expect(store.getState().tabBarOrderByWorktree['wt-2']).toEqual(['host-tab-b'])
  })

  it('notifies the host for every mirrored editor when close all has no active worktree', () => {
    const store = createEditorTabsStore()
    store.setState({ activeWorktreeId: null, worktreesByRepo: pairedServerWorktrees })
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

    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledTimes(2)
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(expect.anything(), 'wt-1', a)
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(expect.anything(), 'wt-2', b)
    expect(store.getState().openFiles).toHaveLength(0)
  })
})
