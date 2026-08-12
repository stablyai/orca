// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { requestEditorFileSave } from './editor-autosave'
import { migrateRestoredEditorFileOwner } from './migrate-restored-editor-file-owner'

const mocks = vi.hoisted(() => ({ writeRuntimeFile: vi.fn() }))

vi.mock('@/runtime/runtime-file-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileClient>()),
  writeRuntimeFile: mocks.writeRuntimeFile
}))

const SOURCE = 'repo-a::/repo-a'
const TARGET = 'repo-b::/repo-b'
const FILE_PATH = '/repo-b/file.md'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function seed(filePath = FILE_PATH): string {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: SOURCE,
    settings: { editorAutoSave: true, editorAutoSaveDelayMs: 250 },
    repos: [
      { id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' },
      { id: 'repo-b', path: '/repo-b', kind: 'git', executionHostId: 'local' }
    ],
    worktreesByRepo: {
      'repo-a': [{ id: SOURCE, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' }],
      'repo-b': [{ id: TARGET, repoId: 'repo-b', path: '/repo-b', hostId: 'local', branch: '' }]
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map()
  } as unknown as Partial<AppState>)
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath,
      worktreeId: SOURCE,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

describe('restored editor owner save lifecycle', () => {
  let detach: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.writeRuntimeFile.mockReset()
  })

  afterEach(() => {
    detach?.()
    detach = null
    vi.useRealTimers()
  })

  it('drains the old save before reparent, then routes explicit save and autosave to the destination', async () => {
    const oldId = seed()
    const firstWrite = deferred()
    mocks.writeRuntimeFile.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined)
    detach = attachEditorAutosaveController(useAppStore)
    useAppStore.getState().setEditorDraft(oldId, 'source save')
    useAppStore.getState().markFileDirty(oldId, true)

    const sourceSave = requestEditorFileSave({ fileId: oldId })
    await vi.waitFor(() => expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(1))
    const migration = migrateRestoredEditorFileOwner(
      oldId,
      {
        worktreeId: TARGET,
        relativePath: 'file.md',
        executionHostId: 'local'
      },
      null
    )
    await Promise.resolve()
    expect(useAppStore.getState().openFiles[0]?.pendingOwnerMigration).toBe(true)
    expect(useAppStore.getState().openFiles[0]?.worktreeId).toBe(SOURCE)
    await expect(requestEditorFileSave({ fileId: oldId })).rejects.toThrow(
      'still restoring its workspace owner'
    )

    firstWrite.resolve()
    await sourceSave
    const migrated = await migration
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) {
      return
    }
    expect(mocks.writeRuntimeFile.mock.calls[0]?.[0]).toMatchObject({ worktreeId: SOURCE })

    useAppStore.getState().setEditorDraft(migrated.fileId, 'explicit destination save')
    useAppStore.getState().markFileDirty(migrated.fileId, true)
    await requestEditorFileSave({ fileId: migrated.fileId })
    expect(mocks.writeRuntimeFile.mock.calls[1]?.[0]).toMatchObject({ worktreeId: TARGET })

    useAppStore.getState().setEditorDraft(migrated.fileId, 'autosave destination')
    useAppStore.getState().markFileDirty(migrated.fileId, true)
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(3))
    expect(mocks.writeRuntimeFile.mock.calls[2]?.[0]).toMatchObject({ worktreeId: TARGET })
    expect(mocks.writeRuntimeFile.mock.calls[2]?.[2]).toBe('autosave destination')
  })

  it('rejects a concurrent migration without clearing the active migration gate', async () => {
    const oldId = seed()
    const firstWrite = deferred()
    mocks.writeRuntimeFile.mockReturnValueOnce(firstWrite.promise)
    detach = attachEditorAutosaveController(useAppStore)
    useAppStore.getState().setEditorDraft(oldId, 'source save')
    useAppStore.getState().markFileDirty(oldId, true)

    const sourceSave = requestEditorFileSave({ fileId: oldId })
    await vi.waitFor(() => expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(1))
    const route = { worktreeId: TARGET, relativePath: 'file.md', executionHostId: 'local' as const }
    const firstMigration = migrateRestoredEditorFileOwner(oldId, route, null)
    await Promise.resolve()
    expect(useAppStore.getState().openFiles[0]?.pendingOwnerMigration).toBe(true)

    await expect(migrateRestoredEditorFileOwner(oldId, route, null)).resolves.toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(useAppStore.getState().openFiles[0]?.pendingOwnerMigration).toBe(true)

    firstWrite.resolve()
    await sourceSave
    await expect(firstMigration).resolves.toMatchObject({ ok: true })
  })

  it('fails closed when the sibling workspace disappears during save quiescence', async () => {
    const oldId = seed()
    const firstWrite = deferred()
    mocks.writeRuntimeFile.mockReturnValueOnce(firstWrite.promise)
    detach = attachEditorAutosaveController(useAppStore)
    useAppStore.getState().setEditorDraft(oldId, 'source save')
    useAppStore.getState().markFileDirty(oldId, true)

    const sourceSave = requestEditorFileSave({ fileId: oldId })
    await vi.waitFor(() => expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(1))
    const migration = migrateRestoredEditorFileOwner(
      oldId,
      { worktreeId: TARGET, relativePath: 'file.md', executionHostId: 'local' },
      null
    )
    await Promise.resolve()
    useAppStore.setState((state) => ({
      worktreesByRepo: { ...state.worktreesByRepo, 'repo-b': [] }
    }))

    firstWrite.resolve()
    await sourceSave
    await expect(migration).resolves.toEqual({ ok: false, reason: 'owner-changed' })
    expect(useAppStore.getState().openFiles[0]).toMatchObject({
      id: oldId,
      worktreeId: SOURCE
    })
    expect(useAppStore.getState().openFiles[0]?.pendingOwnerMigration).toBeUndefined()
  })

  it('fails closed when a folder root changes during save quiescence', async () => {
    const oldId = seed('/notes/todo.md')
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'notes',
          projectGroupId: 'notes-group',
          folderPath: '/notes',
          connectionId: null,
          executionHostId: 'local'
        }
      ],
      projectGroups: [{ id: 'notes-group', name: 'Notes', executionHostId: 'local' }]
    } as unknown as Partial<AppState>)
    const firstWrite = deferred()
    mocks.writeRuntimeFile.mockReturnValueOnce(firstWrite.promise)
    detach = attachEditorAutosaveController(useAppStore)
    useAppStore.getState().setEditorDraft(oldId, 'source save')
    useAppStore.getState().markFileDirty(oldId, true)

    const sourceSave = requestEditorFileSave({ fileId: oldId })
    await vi.waitFor(() => expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(1))
    const migration = migrateRestoredEditorFileOwner(
      oldId,
      { worktreeId: 'folder:notes', relativePath: 'todo.md', executionHostId: 'local' },
      null
    )
    await Promise.resolve()
    useAppStore.setState((state) => ({
      folderWorkspaces: state.folderWorkspaces.map((workspace) => ({
        ...workspace,
        folderPath: '/renamed-notes'
      }))
    }))

    firstWrite.resolve()
    await sourceSave
    await expect(migration).resolves.toEqual({ ok: false, reason: 'owner-changed' })
    expect(useAppStore.getState().openFiles[0]).toMatchObject({
      id: oldId,
      worktreeId: SOURCE
    })
    expect(useAppStore.getState().openFiles[0]?.pendingOwnerMigration).toBeUndefined()
  })

  it('fails closed when direct-SSH authority reconnects during save quiescence', async () => {
    const oldId = seed()
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) =>
        repo.id === 'repo-b'
          ? { ...repo, connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
          : repo
      ),
      worktreesByRepo: {
        ...state.worktreesByRepo,
        'repo-b': state.worktreesByRepo['repo-b'].map((worktree) => ({
          ...worktree,
          hostId: 'ssh:ssh-1'
        }))
      }
    }))
    useAppStore.getState().setSshConnectionState('ssh-1', {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 1
    })
    const firstWrite = deferred()
    mocks.writeRuntimeFile.mockReturnValueOnce(firstWrite.promise)
    detach = attachEditorAutosaveController(useAppStore)
    useAppStore.getState().setEditorDraft(oldId, 'source save')
    useAppStore.getState().markFileDirty(oldId, true)

    const sourceSave = requestEditorFileSave({ fileId: oldId })
    await vi.waitFor(() => expect(mocks.writeRuntimeFile).toHaveBeenCalledTimes(1))
    const migration = migrateRestoredEditorFileOwner(
      oldId,
      { worktreeId: TARGET, relativePath: 'file.md', executionHostId: 'ssh:ssh-1' },
      null
    )
    await Promise.resolve()
    useAppStore.getState().setSshConnectionState('ssh-1', {
      targetId: 'ssh-1',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 1
    })
    useAppStore.getState().setSshConnectionState('ssh-1', {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 2
    })

    firstWrite.resolve()
    await sourceSave
    await expect(migration).resolves.toEqual({ ok: false, reason: 'owner-changed' })
    expect(useAppStore.getState().openFiles[0]).toMatchObject({
      id: oldId,
      worktreeId: SOURCE
    })
    expect(useAppStore.getState().openFiles[0]?.pendingOwnerMigration).toBeUndefined()
  })
})
