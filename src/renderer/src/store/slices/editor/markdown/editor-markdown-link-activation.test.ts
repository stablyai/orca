import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { createEditorStore } from '../editor-slice-test-harness'
import { buildOwnedEditorFileId as ownedEditorFileId } from '../file-ids/editor-file-ids'
import type { AppState } from '../../../types'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../../../runtime/rpc/compatibility/runtime-compatibility-cache'

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

const { openHttpLinkMock } = vi.hoisted(() => ({ openHttpLinkMock: vi.fn() }))
vi.mock('@/lib/browser/navigation/http-link-routing', () => ({
  openHttpLink: openHttpLinkMock
}))

describe('createEditorSlice activateMarkdownLink', () => {
  const openUrlMock = vi.fn()
  const openFileUriMock = vi.fn()
  const pathExistsMock = vi.fn()
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

  it('reveals active-runtime markdown line anchors on the owner-qualified tab id', async () => {
    const store = createEditorStore()
    pathExistsMock.mockResolvedValue(true)
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-active' },
      // The server's rows are stamped as they land; focus alone never names a file's owner.
      worktreesByRepo: {
        'wt-1': [
          makeWorktree({
            id: 'wt-1',
            repoId: 'wt-1',
            path: '/repo',
            hostId: 'runtime:env-active',
            runtimeOwnerEnvironmentId: 'env-active'
          })
        ]
      },
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
    })
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
      fileId: 'editor:wt-1:env-active:%2Frepo%2Fdocs%2Fguide.md',
      line: 10,
      column: 1,
      matchLength: 0
    })
  })
})
