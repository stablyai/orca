import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorSlice } from './editor'
import type { CreateUntitledEditorFileOptions } from '@/lib/create-untitled-editor-file'
import type { AppState } from '../types'

const { createUntitledEditorFileMock, toastErrorMock } = vi.hoisted(() => ({
  createUntitledEditorFileMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('@/lib/create-untitled-editor-file', () => ({
  createUntitledEditorFile: createUntitledEditorFileMock
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const createdFile = {
  filePath: '/repo/untitled',
  relativePath: 'untitled',
  worktreeId: 'wt-1',
  language: 'plaintext',
  isUntitled: true as const,
  mode: 'edit' as const
}

function createEditorStore(overrides?: Record<string, unknown>): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    settings: { editorAutoSave: false },
    repos: [{ id: 'repo-1', path: '/repo', kind: 'git', executionHostId: 'local' }],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local', branch: '' }]
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    recordFeatureInteraction: vi.fn(),
    getKnownWorktreeById: (worktreeId: string) =>
      worktreeId === 'wt-1' ? { id: 'wt-1', repoId: 'repo-1', path: '/repo' } : undefined,
    ...overrides,
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

/** Replaces openFile so the assertions read the exact call the action made. */
function stubOpenFile(store: StoreApi<AppState>): ReturnType<typeof vi.fn> {
  const openFile = vi.fn(() => 'file-id')
  store.setState({ openFile } as unknown as Partial<AppState>)
  return openFile
}

function lastCreateOptions(): CreateUntitledEditorFileOptions {
  return createUntitledEditorFileMock.mock.calls.at(-1)?.[4] as CreateUntitledEditorFileOptions
}

describe('openNewUntitledFileInActiveWorkspace', () => {
  beforeEach(() => {
    createUntitledEditorFileMock.mockReset()
    createUntitledEditorFileMock.mockResolvedValue(createdFile)
    toastErrorMock.mockReset()
  })

  it('creates an extensionless placeholder and opens it in the requested group', async () => {
    const store = createEditorStore()
    const openFile = stubOpenFile(store)

    await store.getState().openNewUntitledFileInActiveWorkspace('group-b')

    expect(createUntitledEditorFileMock).toHaveBeenCalledTimes(1)
    const [worktreePath, worktreeId, connectionId, settings] =
      createUntitledEditorFileMock.mock.calls[0]
    expect(worktreePath).toBe('/repo')
    expect(worktreeId).toBe('wt-1')
    expect(connectionId).toBeUndefined()
    expect(settings).toMatchObject({ activeRuntimeEnvironmentId: null })
    expect(lastCreateOptions()).toMatchObject({ ext: '' })
    expect(lastCreateOptions().initialContent).toBeUndefined()
    expect(openFile).toHaveBeenCalledWith(createdFile, {
      preview: false,
      targetGroupId: 'group-b'
    })
  })

  it('does nothing without an active worktree', async () => {
    const store = createEditorStore({ activeWorktreeId: null })
    const openFile = stubOpenFile(store)

    await store.getState().openNewUntitledFileInActiveWorkspace('group-a')

    expect(createUntitledEditorFileMock).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('does nothing when the active worktree cannot be resolved', async () => {
    const store = createEditorStore({ getKnownWorktreeById: () => undefined })
    const openFile = stubOpenFile(store)

    await store.getState().openNewUntitledFileInActiveWorkspace('group-a')

    expect(createUntitledEditorFileMock).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('surfaces a toast and opens nothing when creation fails', async () => {
    createUntitledEditorFileMock.mockRejectedValue(new Error('EACCES: permission denied'))
    const store = createEditorStore()
    const openFile = stubOpenFile(store)

    await store.getState().openNewUntitledFileInActiveWorkspace('group-a')

    expect(openFile).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock.mock.calls[0][0]).toContain('permission denied')
  })

  it('falls back to the generic failure message when the error carries none', async () => {
    createUntitledEditorFileMock.mockRejectedValue({ code: 'EPERM' })
    const store = createEditorStore()
    stubOpenFile(store)

    await store.getState().openNewUntitledFileInActiveWorkspace('group-a')

    expect(toastErrorMock).toHaveBeenCalledWith('Failed to create untitled file.')
  })

  it('forwards the SSH execution-host expectations captured for the worktree', async () => {
    const store = createEditorStore({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          kind: 'git',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'ssh:ssh-1', branch: '' }]
      },
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected' as const,
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 7
          }
        ]
      ])
    })
    stubOpenFile(store)

    await store.getState().openNewUntitledFileInActiveWorkspace('group-a')

    expect(createUntitledEditorFileMock.mock.calls[0][2]).toBe('ssh-1')
    expect(lastCreateOptions()).toMatchObject({
      ext: '',
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 7,
      operationProvenance: {
        expectedSshConnectionGeneration: 7,
        generation: { route: { executionHostId: 'ssh:ssh-1', runtimeEnvironmentId: null } }
      }
    })
  })

  it('passes an ownership assertion that fails once the host changes mid-flight', async () => {
    const store = createEditorStore()
    const openFile = stubOpenFile(store)
    createUntitledEditorFileMock.mockImplementation(
      async (
        _path: string,
        _worktreeId: string,
        _connectionId: string | undefined,
        _settings: unknown,
        options: CreateUntitledEditorFileOptions
      ) => {
        expect(() => options.assertOperationCurrent?.()).not.toThrow()
        store.setState({
          worktreesByRepo: {
            'repo-1': [
              { id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'ssh:ssh-9', branch: '' }
            ]
          }
        } as unknown as Partial<AppState>)
        options.assertOperationCurrent?.()
        return createdFile
      }
    )

    await store.getState().openNewUntitledFileInActiveWorkspace('group-a')

    expect(openFile).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })
})
