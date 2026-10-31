// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileMutationClient from '@/runtime/runtime-file-mutation-client'
import type * as EditorAutosave from '@/components/editor/editor-autosave'

const mocks = vi.hoisted(() => ({ renameRuntimePath: vi.fn() }))
vi.mock('@/runtime/runtime-file-mutation-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileMutationClient>()
  return { ...actual, renameRuntimePath: mocks.renameRuntimePath }
})
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosave>()
  return { ...actual, requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined) }
})

import { useAppStore } from '@/store'
import { executeOpenEditorPathMove } from './execute-open-editor-path-move'
import { __activeEditorPathMoveCountForTests } from '@/components/editor/editor-path-move-inflight'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { captureWorktreeOperationGenerationSnapshot } from './worktree-operation-generation'
import { buildEditorExternalWatchEventHandler as createExternalWatchEventHandler } from '@/hooks/editor-external-watch-event-reconciliation'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

let main: TabsDrawnFromMain

const CONTEXT = {
  target: { kind: 'local' as const },
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  connectionId: undefined
}

function openDirtyTab(): string {
  const state = useAppStore.getState()
  state.openFile(
    {
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
  const id = useAppStore.getState().openFiles[0]!.id
  state.setEditorDraft(id, 'unsaved work')
  state.markFileDirty(id, true)
  state.setLastKnownDiskSignature(id, 'sig-a')
  return id
}

describe('executeOpenEditorPathMove', () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    mocks.renameRuntimePath.mockReset().mockResolvedValue(undefined)
    main = await drawTabsFromMain(useAppStore)
  })

  afterEach(() => {
    main.close()
    vi.unstubAllGlobals()
  })

  it('renames on disk, retargets the session in place, and installs the verify gate', async () => {
    openDirtyTab()

    await executeOpenEditorPathMove({
      context: CONTEXT,
      fromPath: '/repo/a.md',
      toPath: '/repo/sub/a.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    expect(mocks.renameRuntimePath).toHaveBeenCalledWith(
      CONTEXT,
      '/repo/a.md',
      '/repo/sub/a.md',
      undefined
    )
    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.filePath).toBe('/repo/sub/a.md')
    expect(moved.isDirty).toBe(true)
    expect(moved.lastKnownDiskSignature).toBe('sig-a')
    expect(useAppStore.getState().editorDrafts['/repo/sub/a.md']).toBe('unsaved work')
    expect(moved.pendingSelfMoveEcho?.targetPath).toBe('/repo/sub/a.md')
    expect(__activeEditorPathMoveCountForTests()).toBe(0)
  })

  it('never retargets the same path open from a same-id workspace on a server', async () => {
    const localId = openDirtyTab()
    const state = useAppStore.getState()
    state.openFile({
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-server',
      language: 'markdown',
      mode: 'edit'
    })
    const remote = useAppStore
      .getState()
      .openFiles.find((file) => file.runtimeEnvironmentId === 'env-server')!
    state.setEditorDraft(remote.id, 'server draft')
    state.markFileDirty(remote.id, true)
    useAppStore.setState((current) => ({
      openFiles: current.openFiles.map((file) =>
        file.id === remote.id
          ? {
              ...file,
              operationProvenance: {
                ownershipProjection: 'explicit',
                generation: captureWorktreeOperationGenerationSnapshot(
                  { runtimeEnvironmentId: 'env-server', executionHostId: 'runtime:env-server' },
                  { endpoint: { kind: 'environment', environmentId: 'env-server' }, at: 'ssh:box' }
                )
              }
            }
          : file
      )
    }))
    await executeOpenEditorPathMove({
      context: {
        ...CONTEXT,
        target: { kind: 'environment', environmentId: 'env-server' },
        expectedExecutionHostId: 'ssh:other'
      },
      fromPath: '/repo/a.md',
      toPath: '/repo/other.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
    expect(useAppStore.getState().openFiles.every((file) => file.filePath === '/repo/a.md')).toBe(
      true
    )
    expect(useAppStore.getState().editorDrafts[remote.id]).toBe('server draft')

    await executeOpenEditorPathMove({
      context: { ...CONTEXT, expectedExecutionHostId: 'local' },
      fromPath: '/repo/a.md',
      toPath: '/repo/b.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    const files = useAppStore.getState().openFiles
    expect(files.find((file) => file.runtimeEnvironmentId !== 'env-server')!.filePath).toBe(
      '/repo/b.md'
    )
    expect(files.find((file) => file.id === remote.id)).toMatchObject({
      filePath: '/repo/a.md',
      isDirty: true
    })
    expect(useAppStore.getState().editorDrafts[remote.id]).toBe('server draft')
    expect(useAppStore.getState().editorDrafts[localId]).toBeUndefined()
  })

  it('still moves its own tab when the workspace host focus changes while the rename runs', async () => {
    openDirtyTab()
    mocks.renameRuntimePath.mockImplementation(async () => {
      useAppStore.setState({
        activeWorktreeId: 'wt-1',
        activeWorkspaceExecutionHostId: 'runtime:env-other'
      })
    })

    await executeOpenEditorPathMove({
      context: { ...CONTEXT, expectedExecutionHostId: 'local' },
      fromPath: '/repo/a.md',
      toPath: '/repo/b.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    expect(useAppStore.getState().openFiles[0]!.filePath).toBe('/repo/b.md')
  })

  it('declares the moved file as the document for a document-scoped rename', async () => {
    openDirtyTab()

    await executeOpenEditorPathMove({
      context: CONTEXT,
      fromPath: '/repo/a.md',
      toPath: '/repo/b.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      documentScoped: true
    })

    expect(mocks.renameRuntimePath).toHaveBeenCalledWith(CONTEXT, '/repo/a.md', '/repo/b.md', {
      kind: 'document-folder',
      documentPath: '/repo/a.md'
    })
  })

  it('resolves the verify gate proactively when no destination watcher event arrives', async () => {
    const DISK_CONTENT = 'the file as it exists on disk\n'
    const id = openDirtyTab()
    useAppStore.getState().setLastKnownDiskSignature(id, getDiskBaselineSignature(DISK_CONTENT))
    vi.stubGlobal('window', {
      api: {
        fs: { readFile: vi.fn().mockResolvedValue({ isBinary: false, content: DISK_CONTENT }) }
      }
    })

    await executeOpenEditorPathMove({
      context: CONTEXT,
      fromPath: '/repo/a.md',
      toPath: '/repo/sub/a.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.externalMutation).toBeUndefined()
    expect(moved.isDirty).toBe(true)
    // Keep echo provenance after proactive verify so a later destination watcher event remains recognized as this move’s own echo.
    expect(moved.pendingSelfMoveEcho?.targetPath).toBe('/repo/sub/a.md')
  })

  it('does not raise a false banner when the destination watcher event lands after the move', async () => {
    // FSEvents/SSH events may follow fast verification; consuming provenance early would mark our own rename as an external edit.
    const DISK_CONTENT = 'the file as it exists on disk\n'
    const id = openDirtyTab()
    useAppStore.getState().setLastKnownDiskSignature(id, getDiskBaselineSignature(DISK_CONTENT))
    vi.stubGlobal('window', {
      api: {
        fs: { readFile: vi.fn().mockResolvedValue({ isBinary: false, content: DISK_CONTENT }) }
      }
    })

    await executeOpenEditorPathMove({
      context: CONTEXT,
      fromPath: '/repo/a.md',
      toPath: '/repo/sub/a.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const { handleFsChanged, dispose } = createExternalWatchEventHandler((worktreePath) =>
      worktreePath === '/repo'
        ? {
            worktreeId: 'wt-1',
            worktreePath: '/repo',
            connectionId: undefined,
            runtimeEnvironmentId: null
          }
        : undefined
    )
    handleFsChanged({
      worktreePath: '/repo',
      events: [{ kind: 'update', absolutePath: '/repo/sub/a.md' }]
    })
    await new Promise((resolve) => setTimeout(resolve, 120))

    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.externalMutation).toBeUndefined()
    expect(moved.isDirty).toBe(true)
    dispose()
  })

  it('undoes the on-disk rename when the editor rekey collides', async () => {
    openDirtyTab()
    useAppStore.getState().openFile(
      {
        filePath: '/repo/sub/a.md',
        relativePath: 'sub/a.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const before = useAppStore.getState().openFiles.map((f) => f.id)

    await expect(
      executeOpenEditorPathMove({
        context: CONTEXT,
        fromPath: '/repo/a.md',
        toPath: '/repo/sub/a.md',
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      })
    ).rejects.toThrow(/retarget/)

    expect(mocks.renameRuntimePath).toHaveBeenCalledWith(
      CONTEXT,
      '/repo/a.md',
      '/repo/sub/a.md',
      undefined
    )
    expect(mocks.renameRuntimePath).toHaveBeenCalledWith(
      CONTEXT,
      '/repo/sub/a.md',
      '/repo/a.md',
      undefined
    )
    expect(useAppStore.getState().openFiles.map((f) => f.id)).toEqual(before)
  })

  it('undoes a document-scoped rename with the renamed file as the document', async () => {
    openDirtyTab()
    useAppStore.getState().openFile(
      {
        filePath: '/repo/b.md',
        relativePath: 'b.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    await expect(
      executeOpenEditorPathMove({
        context: CONTEXT,
        fromPath: '/repo/a.md',
        toPath: '/repo/b.md',
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        documentScoped: true
      })
    ).rejects.toThrow(/retarget/)

    expect(mocks.renameRuntimePath).toHaveBeenLastCalledWith(CONTEXT, '/repo/b.md', '/repo/a.md', {
      kind: 'document-folder',
      documentPath: '/repo/b.md'
    })
  })

  it('leaves the store untouched and settles the transaction when the rename fails', async () => {
    openDirtyTab()
    const before = useAppStore.getState().openFiles.map((f) => ({ ...f }))
    mocks.renameRuntimePath.mockRejectedValue(new Error('EACCES'))

    await expect(
      executeOpenEditorPathMove({
        context: CONTEXT,
        fromPath: '/repo/a.md',
        toPath: '/repo/sub/a.md',
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      })
    ).rejects.toThrow('EACCES')

    expect(useAppStore.getState().openFiles).toEqual(before)
    expect(__activeEditorPathMoveCountForTests()).toBe(0)
  })
})
