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

function seed(): string {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: SOURCE,
    settings: { editorAutoSave: true, editorAutoSaveDelayMs: 250 },
    repos: [
      { id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' },
      { id: 'repo-b', path: '/repo-b', kind: 'git', executionHostId: 'local' }
    ],
    worktreesByRepo: {
      'repo-a': [{ id: SOURCE, repoId: 'repo-a', path: '/repo-a', hostId: 'local' }],
      'repo-b': [{ id: TARGET, repoId: 'repo-b', path: '/repo-b', hostId: 'local' }]
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
      filePath: FILE_PATH,
      relativePath: FILE_PATH,
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
})
