import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import type * as EditorAutosaveModule from '@/components/editor/autosave/editor-autosave'
import type { FsChangedPayload } from '../../../shared/file-watch/filesystem-change-event'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
// Stub autosave’s window-event exports so the handler runs in headless Node.
vi.mock('@/components/editor/autosave/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosaveModule>()
  return {
    ...actual,
    notifyEditorExternalFileChange: vi.fn(),
    getOpenFilesForExternalFileChange: vi.fn(() => [])
  }
})

import {
  buildEditorExternalWatchEventHandler as createExternalWatchEventHandler,
  EXTERNAL_MUTATION_DEBOUNCE_MS
} from './editor-external-watch-event-reconciliation'
import { useAppStore } from '@/store'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '@/components/editor/autosave/editor-autosave'
import {
  __clearSelfWriteRegistryForTests,
  recordSelfWrite
} from '@/components/editor/external-changes/editor-self-write-registry'
import { __clearEditorPathMovesForTests } from '@/components/editor/editor-path-move-inflight'

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
    language: 'markdown',
    mode: 'edit' as const,
    isDirty: false
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(useAppStore.getState).mockReturnValue({
      ...createTestStore().getState(),
      openFiles: [fileNotes],
      setExternalMutation
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
    __clearEditorPathMovesForTests()
  })

  function payload(events: FsChangedPayload['events']): FsChangedPayload {
    return { worktreePath: '/repo', events }
  }

  it('does not flash deleted when a create at the same path arrives in the next payload', () => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)
    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]))

    vi.advanceTimersByTime(10)
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')

    handleFsChanged(payload([{ kind: 'create', absolutePath: '/repo/notes.md' }]))

    vi.advanceTimersByTime(500)
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')

    dispose()
  })

  it('still reloads a clean sibling diff tab when the edit tab for the path is dirty', () => {
    const dirtyFile = {
      ...fileNotes,
      isDirty: true
    }
    const cleanDiffTab = {
      id: 'diff-notes',
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      language: 'markdown',
      mode: 'diff' as const,
      diffSource: 'unstaged' as const,
      isDirty: false
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      ...createTestStore().getState(),
      openFiles: [dirtyFile, cleanDiffTab],
      setExternalMutation
    })
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([dirtyFile, cleanDiffTab] as never)
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]))
    vi.advanceTimersByTime(EXTERNAL_MUTATION_DEBOUNCE_MS)

    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'changed')
    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'notes.md',
      runtimeEnvironmentId: null
    })
    dispose()
  })

  it('does not mark a dirty tab for the echo of Orca’s own save', async () => {
    const dirtyFile = {
      ...fileNotes,
      isDirty: true
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      ...createTestStore().getState(),
      openFiles: [dirtyFile],
      setExternalMutation
    })
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([dirtyFile] as never)
    const readFile = vi.fn().mockResolvedValue({ content: 'orca save', isBinary: false })
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    recordSelfWrite('/repo/notes.md', 'orca save')
    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]))
    await vi.advanceTimersByTimeAsync(100)

    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'changed')
    dispose()
  })

  it('marks a dirty tab when a genuine external write lands inside the self-write TTL', async () => {
    const dirtyFile = {
      ...fileNotes,
      isDirty: true
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      ...createTestStore().getState(),
      openFiles: [dirtyFile],
      setExternalMutation
    })
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([dirtyFile] as never)
    const readFile = vi.fn().mockResolvedValue({ content: 'agent content', isBinary: false })
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    recordSelfWrite('/repo/notes.md', 'orca save')
    handleFsChanged(payload([{ kind: 'update', absolutePath: '/repo/notes.md' }]))
    await vi.advanceTimersByTimeAsync(100)

    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'changed')
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
      ...createTestStore().getState(),
      openFiles: [localFile, runtimeFile],
      setExternalMutation
    })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]), 'env-1')
    vi.advanceTimersByTime(EXTERNAL_MUTATION_DEBOUNCE_MS)

    expect(setExternalMutation).toHaveBeenCalledWith('runtime-notes', 'deleted')
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')
    dispose()
  })
})
