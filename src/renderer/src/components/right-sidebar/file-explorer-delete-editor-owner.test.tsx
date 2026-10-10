// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { getFileExplorerOperationOwner } from './file-explorer-operation-owner'
import { useFileDeletion } from './useFileDeletion'

const { save, quiesce, remove, confirm, toastError } = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue(undefined),
  quiesce: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn().mockResolvedValue(true),
  toastError: vi.fn()
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Delete' }))
vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorFileSave: save,
  requestEditorSaveQuiesce: quiesce
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  deleteRuntimePath: remove,
  readRuntimeFileContent: vi.fn().mockResolvedValue({ content: 'owner', isBinary: false }),
  writeRuntimeFile: vi.fn()
}))
vi.mock('@/components/right-sidebar/fileExplorerUndoRedo', () => ({
  commitFileExplorerOp: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const initialState = useAppStore.getInitialState()
const root = '/same/project'
type Owner = { hostId: ExecutionHostId; environmentId?: string }
const cases: {
  name: string
  owner: Owner
  foreign: Owner
  sameOwner?: boolean
  directory?: boolean
  prefixOnly?: boolean
  stale?: boolean
  folder?: boolean
}[] = [
  {
    name: 'managed versus desktop',
    owner: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    foreign: { hostId: 'local' }
  },
  {
    name: 'desktop versus managed',
    owner: { hostId: 'local' },
    foreign: { hostId: 'runtime:host-a', environmentId: 'host-a' }
  },
  {
    name: 'two managed hosts',
    owner: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    foreign: { hostId: 'runtime:host-b', environmentId: 'host-b' }
  },
  {
    name: 'two direct SSH hosts',
    owner: { hostId: 'ssh:target-a' },
    foreign: { hostId: 'ssh:target-b' }
  },
  {
    name: 'same managed host through another workspace',
    owner: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    foreign: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    sameOwner: true
  },
  {
    name: 'directory descendants on another host',
    owner: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    foreign: { hostId: 'local' },
    directory: true
  },
  {
    name: 'same-host sibling with a matching path prefix',
    owner: { hostId: 'local' },
    foreign: { hostId: 'local' },
    prefixOnly: true
  },
  {
    name: 'stale editor provenance',
    owner: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    foreign: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    stale: true
  },
  {
    name: 'two managed folder workspaces',
    owner: { hostId: 'runtime:host-a', environmentId: 'host-a' },
    foreign: { hostId: 'runtime:host-b', environmentId: 'host-b' },
    folder: true
  },
  {
    name: 'two SSH hosts through one runtime',
    owner: { hostId: 'ssh:target-a', environmentId: 'host-a' },
    foreign: { hostId: 'ssh:target-b', environmentId: 'host-a' }
  }
]

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initialState, true)
})
afterEach(() => useAppStore.setState(initialState, true))

for (const scenario of cases) {
  it(`saves and closes only the deletion owner's editor: ${scenario.name}`, async () => {
    const ownerId = scenario.folder ? folderWorkspaceKey('owner-folder') : `owner::${root}`
    const foreignId = scenario.folder ? folderWorkspaceKey('foreign-folder') : `foreign::${root}`
    const connectionStates = new Map(
      ['target-a', 'target-b'].map((targetId) => [
        targetId,
        {
          targetId,
          status: 'connected' as const,
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 1
        }
      ])
    )
    useAppStore.setState({
      repos: [],
      folderWorkspaces: scenario.folder
        ? [
            makeFolderWorkspace({
              id: 'owner-folder',
              folderPath: root,
              executionHostId: scenario.owner.hostId
            }),
            makeFolderWorkspace({
              id: 'foreign-folder',
              folderPath: root,
              executionHostId: scenario.foreign.hostId
            })
          ]
        : [],
      detectedWorktreesByRepo: {},
      activeWorktreeId: ownerId,
      activeWorkspaceExecutionHostId: scenario.owner.hostId,
      worktreesByRepo: scenario.folder
        ? {}
        : {
            owner: [
              makeWorktree({
                id: ownerId,
                repoId: 'owner',
                path: root,
                hostId: scenario.owner.hostId,
                runtimeOwnerEnvironmentId: scenario.owner.environmentId
              })
            ],
            foreign: [
              makeWorktree({
                id: foreignId,
                repoId: 'foreign',
                path: root,
                hostId: scenario.foreign.hostId,
                runtimeOwnerEnvironmentId: scenario.foreign.environmentId
              })
            ]
          },
      sshConnectionStates: connectionStates,
      sshStateByEnvironment: new Map([
        [
          'host-a',
          {
            targetsHydrated: true,
            targetGenerations: new Map(),
            targetLabels: new Map(),
            removedTargetLabels: new Map(),
            connectionStates
          }
        ]
      ])
    })
    const makeFile = (id: string, worktreeId: string, owner: Owner): OpenFile => ({
      id,
      worktreeId,
      filePath: `${root}/file.txt`,
      relativePath: 'file.txt',
      language: 'plaintext',
      mode: 'edit',
      isDirty: true,
      runtimeEnvironmentId: owner.environmentId ?? null,
      operationProvenance: captureEditorFileOperationProvenance(
        useAppStore.getState(),
        worktreeId,
        owner.environmentId ?? null,
        true
      )
    })
    const openFiles = [
      makeFile('own-editor', ownerId, scenario.owner),
      makeFile('foreign-editor', foreignId, scenario.foreign)
    ]
    if (scenario.prefixOnly && openFiles[1]) {
      openFiles[1].filePath = `${root}/file.txt-other`
    }
    if (scenario.stale) {
      useAppStore.setState((state) => ({
        worktreesByRepo: {
          ...state.worktreesByRepo,
          foreign: [
            makeWorktree({
              id: foreignId,
              repoId: 'foreign',
              path: root,
              hostId: 'runtime:replacement',
              runtimeOwnerEnvironmentId: 'replacement'
            })
          ]
        }
      }))
    }
    const close = vi.fn()
    const { result } = renderHook(() =>
      useFileDeletion({
        activeWorktreeId: ownerId,
        openFiles,
        closeFile: close,
        refreshDir: vi.fn().mockResolvedValue(undefined),
        setSelectedPaths: vi.fn(),
        isWindows: false
      })
    )
    await act(async () =>
      result.current.requestDelete({
        name: 'file.txt',
        path: scenario.directory ? root : `${root}/file.txt`,
        relativePath: scenario.directory ? '' : 'file.txt',
        isDirectory: scenario.directory ?? false,
        depth: 0,
        operationOwner: getFileExplorerOperationOwner(ownerId)
      })
    )
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    expect(toastError).not.toHaveBeenCalled()
    const selected = scenario.sameOwner ? ['own-editor', 'foreign-editor'] : ['own-editor']
    expect(save.mock.calls).toEqual(selected.map((fileId) => [{ fileId }]))
    expect(quiesce.mock.calls).toEqual(selected.map((fileId) => [{ fileId }]))
    expect(close.mock.calls).toEqual(selected.map((fileId) => [fileId]))
  })
}
