import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { acquireEditorFileOperation } from '@/lib/editor-file-operation-owner'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { editorSaveWriterView } from './editor-save-writer-view'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './editor-autosave'
import type { FileContent } from './editor-panel-content-types'

export function registerEditorPanelHostContentRecoveryTests(
  mocks: { getState: ReturnType<typeof vi.fn>; readRuntimeFileContent: ReturnType<typeof vi.fn> },
  fileContents: () => Record<string, FileContent>,
  createOpenFile: () => OpenFile,
  reloadContent: (file: OpenFile, options?: { wakeWslDistro?: boolean }) => void,
  render: (file: OpenFile) => Promise<void>
): void {
  it('lets the active tab load and its Retry start a stopped WSL distro, but not other reloads', async () => {
    const activeFile = createOpenFile()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'text', isBinary: false })
    await render(activeFile)
    await vi.waitFor(() => expect(fileContents()[activeFile.id]?.content).toBe('text'))
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.objectContaining({ wakeWslDistro: true })
    )

    await act(async () => reloadContent(activeFile))
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ wakeWslDistro: true })
    )
    await act(async () => reloadContent(activeFile, { wakeWslDistro: true }))
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.objectContaining({ wakeWslDistro: true })
    )
  })

  it('reloads the same paired host after restart without reviving an issued operation', async () => {
    const store = createTestStore()
    const environment = {
      id: 'runtime-1',
      name: 'Paired host',
      createdAt: 1,
      updatedAt: 1,
      pairingRevision: 1,
      hostKeyFingerprint: 'original-host-key',
      lastUsedAt: null,
      runtimeId: null,
      preferredEndpointId: 'endpoint',
      endpoints: [
        { id: 'endpoint', kind: 'websocket' as const, label: 'Host', endpoint: 'ws://host' }
      ]
    }
    const file: OpenFile = {
      id: 'remote-readme',
      filePath: '/repo/README.md',
      relativePath: 'README.md',
      worktreeId: `${TEST_REPO.id}::/repo`,
      language: 'markdown',
      runtimeEnvironmentId: environment.id,
      mode: 'edit',
      isDirty: false
    }
    store.setState({
      settings: null,
      openFiles: [file],
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:runtime-1' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({
            id: file.worktreeId,
            repoId: TEST_REPO.id,
            path: '/repo',
            hostId: 'runtime:runtime-1',
            runtimeOwnerEnvironmentId: environment.id
          })
        ]
      }
    })
    mocks.getState.mockImplementation(store.getState)
    store.getState().setRuntimeEnvironments([environment])
    const publishStatus = (runtimeId: string, sequence: number) =>
      store.getState().applyRuntimeHostStatusSnapshot({
        environmentId: environment.id,
        pairingRevision: 1,
        sequence,
        checkedAt: sequence,
        status: createCompatibleRuntimeStatusResponse(runtimeId).result,
        verification: 'verified',
        transport: 'ready'
      })
    publishStatus('before-restart', 1)
    const issued = acquireEditorFileOperation(store.getState, file)
    expect(issued.provenance.generation.authority).toEqual({
      endpoint: { kind: 'environment', environmentId: environment.id },
      at: 'local'
    })
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'original host text',
      isBinary: false
    })
    await render(file)
    await vi.waitFor(() => expect(fileContents()[file.id]?.content).toBe('original host text'))

    publishStatus('after-restart', 2)
    store.getState().markEnvironmentSshStateStale(environment.id)
    expect(() => issued.assertCurrent()).toThrow('Reopen the file')
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'updated host text',
      isBinary: false
    })
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
          detail: {
            worktreeId: file.worktreeId,
            worktreePath: '/repo',
            relativePath: file.relativePath,
            runtimeEnvironmentId: environment.id
          }
        })
      )
    })
    await vi.waitFor(() => expect(fileContents()[file.id]?.content).toBe('updated host text'))
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { kind: 'environment', environmentId: environment.id },
        relativePath: 'README.md'
      })
    )
    expect(store.getState().openFiles[0].operationProvenance).toBe(issued.file.operationProvenance)
    expect(editorSaveWriterView(store.getState(), file.id, 'autosave')?.id).toBe(file.id)
    expect(() => issued.assertCurrent()).toThrow('Reopen the file')
    store.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
    expect(
      acquireEditorFileOperation(store.getState, issued.file).provenance.generation
        .runtimePairingRevision
    ).toBe(2)
    expect(store.getState().openFiles[0].operationProvenance).toBe(issued.file.operationProvenance)
    store
      .getState()
      .setRuntimeEnvironments([
        { ...environment, pairingRevision: 3, hostKeyFingerprint: 'replacement-host-key' }
      ])
    expect(() => acquireEditorFileOperation(store.getState, issued.file)).toThrow('Reopen the file')
  })
}
