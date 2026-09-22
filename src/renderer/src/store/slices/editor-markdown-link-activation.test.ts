import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createEditorStore, ownedEditorFileId } from './editor-slice-test-harness'
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

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

const { openHttpLinkMock } = vi.hoisted(() => ({ openHttpLinkMock: vi.fn() }))
vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: openHttpLinkMock
}))

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
