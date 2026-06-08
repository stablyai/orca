import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import type * as EditorAutosaveModule from '@/components/editor/editor-autosave'
import type { FsChangedPayload } from '../../../shared/types'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
// Why: editor-autosave calls window.dispatchEvent at module scope paths; the
// vitest 'node' environment has no window. Stub the two exports we use so the
// handler can run headlessly.
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosaveModule>()
  return {
    ...actual,
    notifyEditorExternalFileChange: vi.fn(),
    getOpenFilesForExternalFileChange: vi.fn(() => [])
  }
})

import {
  createExternalWatchEventHandler,
  getOverflowExternalReloadTargets,
  getWatchedTargetKey
} from './useEditorExternalWatch'
import { useAppStore } from '@/store'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '@/components/editor/editor-autosave'
import {
  __clearSelfWriteRegistryForTests,
  recordSelfWrite
} from '@/components/editor/editor-self-write-registry'

describe('getWatchedTargetKey', () => {
  it('changes when a worktree gains an SSH connection id', () => {
    expect(
      getWatchedTargetKey({
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: undefined,
        runtimeEnvironmentId: null
      })
    ).not.toBe(
      getWatchedTargetKey({
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'conn-1',
        runtimeEnvironmentId: null
      })
    )
  })

  it('changes when the active runtime environment changes', () => {
    expect(
      getWatchedTargetKey({
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: undefined,
        runtimeEnvironmentId: null
      })
    ).not.toBe(
      getWatchedTargetKey({
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: undefined,
        runtimeEnvironmentId: 'env-1'
      })
    )
  })
})

describe('getOverflowExternalReloadTargets', () => {
  const setExternalMutation = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears tombstones and reloads clean edit tabs on overflow', () => {
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'notes.md',
          mode: 'edit',
          isDirty: false,
          externalMutation: 'deleted'
        },
        {
          id: 'file-2',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'dirty.md',
          mode: 'edit',
          isDirty: true
        },
        {
          id: 'file-3',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'staged.ts',
          mode: 'diff',
          diffSource: 'staged',
          isDirty: false
        }
      ],
      setExternalMutation
    } as never)

    expect(
      getOverflowExternalReloadTargets({
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      })
    ).toEqual([
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        relativePath: 'notes.md',
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        relativePath: 'staged.ts',
        runtimeEnvironmentId: null
      }
    ])
    expect(setExternalMutation).toHaveBeenCalledWith('file-1', null)
  })

  it('limits overflow reload targets to the matching runtime owner', () => {
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: 'local-file',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'local.md',
          mode: 'edit',
          isDirty: false,
          externalMutation: 'deleted',
          runtimeEnvironmentId: null
        },
        {
          id: 'runtime-file',
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          relativePath: 'runtime.md',
          mode: 'edit',
          isDirty: false,
          externalMutation: 'deleted',
          runtimeEnvironmentId: 'env-1'
        }
      ],
      setExternalMutation
    } as never)

    expect(
      getOverflowExternalReloadTargets({
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        runtimeEnvironmentId: 'env-1'
      })
    ).toEqual([
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        relativePath: 'runtime.md',
        runtimeEnvironmentId: 'env-1'
      }
    ])
    expect(setExternalMutation).toHaveBeenCalledWith('runtime-file', null)
    expect(setExternalMutation).not.toHaveBeenCalledWith('local-file', null)
  })
})

describe('createExternalWatchEventHandler tombstone coalescing', () => {
  const setExternalMutation = vi.fn()
  const findTarget = (
    worktreePath: string,
    runtimeEnvironmentId: string | null = null
  ):
    | {
        worktreeId: string
        worktreePath: string
        connectionId: string | undefined
        runtimeEnvironmentId: string | null
      }
    | undefined =>
    worktreePath === '/repo'
      ? {
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          connectionId: undefined,
          runtimeEnvironmentId
        }
      : undefined

  const fileNotes = {
    id: 'file-notes',
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    mode: 'edit' as const,
    isDirty: false
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [fileNotes],
      setExternalMutation
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  function payload(events: FsChangedPayload['events']): FsChangedPayload {
    return { worktreePath: '/repo', events }
  }

  it('does not flash deleted when a create at the same path arrives in the next payload', () => {
    // Simulates macOS atomic write: two back-to-back payloads, delete then create.
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)
    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]))

    // Advance less than the debounce window; the deleted tombstone must not
    // have fired yet.
    vi.advanceTimersByTime(10)
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')

    handleFsChanged(payload([{ kind: 'create', absolutePath: '/repo/notes.md' }]))

    // Flush anything remaining; the pending tombstone should have been cancelled.
    vi.advanceTimersByTime(500)
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')

    dispose()
  })

  it('still sets deleted after the debounce window for a naked delete', () => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)
    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]))

    expect(setExternalMutation).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'deleted')

    dispose()
  })

  it('resolves batched delete+create in a single payload synchronously as renamed', () => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)
    handleFsChanged(
      payload([
        { kind: 'delete', absolutePath: '/repo/notes.md' },
        { kind: 'create', absolutePath: '/repo/subdir/notes.md' }
      ])
    )

    // The single-payload rename-correlated path must not defer — the decision
    // is already correct because both events are visible at once.
    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'renamed')

    dispose()
  })

  it('reloads Windows editor tabs when watcher event casing differs', () => {
    const file = {
      id: 'file-win',
      worktreeId: 'wt-win',
      worktreePath: 'C:\\Repo',
      filePath: 'C:\\Repo\\notes.md',
      relativePath: 'notes.md',
      mode: 'edit' as const,
      isDirty: false
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [file],
      setExternalMutation
    } as never)
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([file] as never)
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-win',
      worktreePath: 'C:\\Repo',
      connectionId: undefined,
      runtimeEnvironmentId: 'env-1'
    }))

    handleFsChanged({
      worktreePath: 'c:\\repo',
      events: [{ kind: 'update', absolutePath: 'c:\\repo\\notes.md', isDirectory: false }]
    })
    vi.advanceTimersByTime(100)

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-win',
      worktreePath: 'C:\\Repo',
      relativePath: 'notes.md',
      runtimeEnvironmentId: 'env-1'
    })
    dispose()
  })

  it('reloads UNC editor tabs without collapsing the share root', () => {
    const file = {
      id: 'file-unc',
      worktreeId: 'wt-unc',
      worktreePath: '//Server/Share/Repo',
      filePath: '//Server/Share/Repo/notes.md',
      relativePath: 'notes.md',
      mode: 'edit' as const,
      isDirty: false
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [file],
      setExternalMutation
    } as never)
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([file] as never)
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-unc',
      worktreePath: '//Server/Share/Repo',
      connectionId: undefined,
      runtimeEnvironmentId: 'env-1'
    }))

    handleFsChanged({
      worktreePath: '//server/share/repo',
      events: [{ kind: 'update', absolutePath: '//server/share/repo/notes.md', isDirectory: false }]
    })
    vi.advanceTimersByTime(100)

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-unc',
      worktreePath: '//Server/Share/Repo',
      relativePath: 'notes.md',
      runtimeEnvironmentId: 'env-1'
    })
    dispose()
  })

  it('does not drop external edits that arrive inside the self-write TTL', async () => {
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [fileNotes],
      setExternalMutation
    } as never)
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([fileNotes] as never)
    const readFile = vi.fn().mockResolvedValue({ content: 'agent edit', isBinary: false })
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    recordSelfWrite('/repo/notes.md', 'orca save')
    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]))
    await vi.advanceTimersByTimeAsync(100)

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'notes.md',
      runtimeEnvironmentId: null
    })
    dispose()
  })

  it('still suppresses the watcher echo from Orca self-writes', async () => {
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [fileNotes],
      setExternalMutation
    } as never)
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([fileNotes] as never)
    const readFile = vi.fn().mockResolvedValue({ content: 'orca save', isBinary: false })
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    recordSelfWrite('/repo/notes.md', 'orca save')
    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]))
    await vi.advanceTimersByTimeAsync(100)

    expect(notifyEditorExternalFileChange).not.toHaveBeenCalled()
    dispose()
  })

  it('does not let a local self-write stamp suppress a runtime owner update', async () => {
    const runtimeFile = {
      ...fileNotes,
      runtimeEnvironmentId: 'env-1'
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [runtimeFile],
      setExternalMutation
    } as never)
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([runtimeFile] as never)
    const readFile = vi.fn().mockResolvedValue({ content: 'local save', isBinary: false })
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    recordSelfWrite('/repo/notes.md', 'local save', null)
    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]), 'env-1')
    await vi.advanceTimersByTimeAsync(100)

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'notes.md',
      runtimeEnvironmentId: 'env-1'
    })
    dispose()
  })

  it('routes local and runtime watch events to the matching editor owner', () => {
    const localFile = fileNotes
    const runtimeFile = {
      ...fileNotes,
      id: 'runtime-notes',
      runtimeEnvironmentId: 'env-1'
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [localFile, runtimeFile],
      setExternalMutation
    } as never)
    vi.mocked(getOpenFilesForExternalFileChange).mockImplementation((_files, notification) =>
      notification.runtimeEnvironmentId === 'env-1'
        ? ([runtimeFile] as never)
        : ([localFile] as never)
    )
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]), null)
    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]), 'env-1')
    vi.advanceTimersByTime(100)

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'notes.md',
      runtimeEnvironmentId: null
    })
    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'notes.md',
      runtimeEnvironmentId: 'env-1'
    })
    dispose()
  })

  it('tombstones only the matching owner for same-path delete events', () => {
    const localFile = fileNotes
    const runtimeFile = {
      ...fileNotes,
      id: 'runtime-notes',
      runtimeEnvironmentId: 'env-1'
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [localFile, runtimeFile],
      setExternalMutation
    } as never)
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]), 'env-1')
    vi.advanceTimersByTime(200)

    expect(setExternalMutation).toHaveBeenCalledWith('runtime-notes', 'deleted')
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')
    dispose()
  })
})
