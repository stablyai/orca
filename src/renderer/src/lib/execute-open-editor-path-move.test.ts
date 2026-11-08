// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileMutationClient from '@/runtime/files/mutations/runtime-file-mutation-client'
import type * as EditorAutosave from '@/components/editor/autosave/editor-autosave'

const mocks = vi.hoisted(() => ({ renameRuntimePath: vi.fn() }))
vi.mock('@/runtime/files/mutations/runtime-file-mutation-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileMutationClient>()
  return { ...actual, renameRuntimePath: mocks.renameRuntimePath }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/components/editor/autosave/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosave>()
  return { ...actual, requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined) }
})

import { useAppStore } from '@/store'
import { executeOpenEditorPathMove } from './execute-open-editor-path-move'

import { captureWorktreeOperationGenerationSnapshot } from './worktree-operation-generation'

import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'

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
})
