import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EditorAutosaveModule from '@/components/editor/editor-autosave'
import type { FsChangedPayload } from '../../../shared/types'

vi.mock('@/store', () => ({
  useAppStore: { getState: vi.fn() }
}))
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
  verifyLatchedMoveDestinations
} from './useEditorExternalWatch'
import { useAppStore } from '@/store'
import { getOpenFilesForExternalFileChange } from '@/components/editor/editor-autosave'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import {
  __clearEditorPathMovesForTests,
  beginEditorPathMove,
  settleEditorPathMove
} from '@/components/editor/editor-path-move-inflight'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'

const findTarget = (worktreePath: string, runtimeEnvironmentId: string | null = null) =>
  worktreePath === '/repo'
    ? { worktreeId: 'wt-1', worktreePath: '/repo', connectionId: undefined, runtimeEnvironmentId }
    : undefined

function payload(events: FsChangedPayload['events']): FsChangedPayload {
  return { worktreePath: '/repo', events }
}

describe('self-move source suppression (in-flight)', () => {
  const setExternalMutation = vi.fn()
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
    __clearEditorPathMovesForTests()
  })

  function beginMove(): void {
    beginEditorPathMove({
      operationId: 'op-1',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      sourcePaths: ['/repo/notes.md']
    })
  }

  it('does not tombstone the source of an in-flight move (tab still at old path)', () => {
    beginMove()
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]))
    vi.advanceTimersByTime(200)

    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'deleted')
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'renamed')
    dispose()
  })

  it('does not tombstone a tab opened UNDER a moving directory mid-rename', () => {
    // A directory move registers the root; a file opened under it during the
    // in-flight window is not in the registered tab list but must still be
    // recognized as the move's own echo (prefix match) — no false conflict.
    const lateTab = {
      id: 'file-late',
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/src/late.md',
      relativePath: 'src/late.md',
      mode: 'edit' as const,
      isDirty: true
    }
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [lateTab],
      setExternalMutation
    } as never)
    beginEditorPathMove({
      operationId: 'op-dir',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      sourcePaths: ['/repo/src']
    })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    // The rename echo arrives as a delete+create pair for the old subtree path.
    handleFsChanged(
      payload([
        { kind: 'delete', absolutePath: '/repo/src/late.md' },
        { kind: 'create', absolutePath: '/repo/dst/late.md' }
      ])
    )
    vi.advanceTimersByTime(200)

    expect(setExternalMutation).not.toHaveBeenCalledWith('file-late', 'renamed')
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-late', 'deleted')
    dispose()
  })

  it('tombstones a genuine delete once the move has settled', () => {
    beginMove()
    settleEditorPathMove('op-1')
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payload([{ kind: 'delete', absolutePath: '/repo/notes.md' }]))
    vi.advanceTimersByTime(200)

    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'deleted')
    dispose()
  })
})

describe('self-move echo verification (content identity)', () => {
  const setExternalMutation = vi.fn()
  const setPendingLiveDiskVerification = vi.fn()
  const clearSelfMoveEcho = vi.fn()

  const BASELINE_CONTENT = 'the file on disk\n'
  const baselineSignature = getDiskBaselineSignature(BASELINE_CONTENT)
  const TARGET_PATH = '/repo/subdir/notes.md'

  function movedDirtyTab(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'file-notes',
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: TARGET_PATH,
      relativePath: 'subdir/notes.md',
      mode: 'edit' as const,
      isDirty: true,
      lastKnownDiskSignature: baselineSignature,
      // Installed on the tab by the rekey; routes the echo into verification.
      pendingSelfMoveEcho: { operationId: 'op-1', targetPath: TARGET_PATH },
      ...overrides
    }
  }

  function mockState(file: Record<string, unknown>): void {
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [file],
      setExternalMutation,
      setPendingLiveDiskVerification,
      clearSelfMoveEcho
    } as never)
    vi.mocked(getOpenFilesForExternalFileChange).mockReturnValue([file] as never)
  }

  function payloadFor(): FsChangedPayload {
    return { worktreePath: '/repo', events: [{ kind: 'update', absolutePath: TARGET_PATH }] }
  }

  function stubDiskRead(result: unknown): void {
    vi.stubGlobal('window', { api: { fs: { readFile: vi.fn().mockResolvedValue(result) } } })
  }

  function stubDiskReadError(error: Error): void {
    vi.stubGlobal('window', { api: { fs: { readFile: vi.fn().mockRejectedValue(error) } } })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    __clearSelfWriteRegistryForTests()
    __clearEditorPathMovesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('suspends autosave synchronously and suppresses when disk matches the baseline', async () => {
    mockState(movedDirtyTab())
    stubDiskRead({ isBinary: false, content: BASELINE_CONTENT })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payloadFor())
    expect(setPendingLiveDiskVerification).toHaveBeenCalledWith('file-notes', true)
    await vi.advanceTimersByTimeAsync(100)

    expect(setExternalMutation).not.toHaveBeenCalledWith('file-notes', 'changed')
    expect(setPendingLiveDiskVerification).toHaveBeenCalledWith('file-notes', false)
    expect(clearSelfMoveEcho).toHaveBeenCalledWith('file-notes')
    dispose()
  })

  it('marks changed when a genuine external write differs from the baseline', async () => {
    mockState(movedDirtyTab())
    stubDiskRead({ isBinary: false, content: 'an agent rewrote this file\n' })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payloadFor())
    await vi.advanceTimersByTimeAsync(100)

    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'changed')
    dispose()
  })

  it('fails closed (marks changed) when the tab has no disk baseline', async () => {
    mockState(movedDirtyTab({ lastKnownDiskSignature: undefined }))
    stubDiskRead({ isBinary: false, content: BASELINE_CONTENT })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payloadFor())
    await vi.advanceTimersByTimeAsync(100)

    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'changed')
    dispose()
  })

  it('fails closed when the destination read errors', async () => {
    mockState(movedDirtyTab())
    stubDiskReadError(new Error('EACCES'))
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payloadFor())
    await vi.advanceTimersByTimeAsync(100)

    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'changed')
    expect(setPendingLiveDiskVerification).toHaveBeenCalledWith('file-notes', false)
    dispose()
  })

  it('fails closed when the destination is binary', async () => {
    mockState(movedDirtyTab())
    stubDiskRead({ isBinary: true, content: '' })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payloadFor())
    await vi.advanceTimersByTimeAsync(100)

    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'changed')
    dispose()
  })

  it('does not verify an event with no move provenance (normal changed-on-disk path)', async () => {
    mockState(movedDirtyTab({ pendingSelfMoveEcho: undefined }))
    stubDiskRead({ isBinary: false, content: BASELINE_CONTENT })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(findTarget)

    handleFsChanged(payloadFor())
    await vi.advanceTimersByTimeAsync(100)

    // No provenance -> not treated as a move echo -> normal path marks it changed.
    expect(setExternalMutation).toHaveBeenCalledWith('file-notes', 'changed')
    dispose()
  })
})

describe('verifyLatchedMoveDestinations (proactive, cross-worktree path)', () => {
  const setPendingLiveDiskVerification = vi.fn()
  const clearSelfMoveEcho = vi.fn()
  const setExternalMutation = vi.fn()

  const CONTENT = 'the echoed file on disk\n'
  const baseline = getDiskBaselineSignature(CONTENT)
  // A floating-workspace tab: relativePath is relative to its OWN root (`../…`)
  // and must NOT be joined onto the initiating worktree path.
  const FLOATING_FILE_PATH = '/elsewhere/notes/readme.md'
  const floatingTab = {
    id: 'file-x',
    worktreeId: 'floating',
    worktreePath: '/elsewhere',
    filePath: FLOATING_FILE_PATH,
    relativePath: '../notes/readme.md',
    runtimeEnvironmentId: null,
    mode: 'edit' as const,
    isDirty: true,
    lastKnownDiskSignature: baseline,
    pendingSelfMoveEcho: { operationId: 'op-1', targetPath: FLOATING_FILE_PATH }
  }
  let readFile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    readFile = vi.fn().mockResolvedValue({ isBinary: false, content: CONTENT })
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [floatingTab],
      setPendingLiveDiskVerification,
      clearSelfMoveEcho,
      setExternalMutation
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads the tab own filePath, not the initiating worktree joined with its relativePath', async () => {
    verifyLatchedMoveDestinations('/initiating-worktree', undefined, ['file-x'])
    await vi.advanceTimersByTimeAsync(50)

    expect(readFile).toHaveBeenCalledWith(expect.objectContaining({ filePath: FLOATING_FILE_PATH }))
    // Disk == baseline -> echo -> suppress + release the gate, no false banner.
    expect(setExternalMutation).not.toHaveBeenCalledWith('file-x', 'changed')
    expect(setPendingLiveDiskVerification).toHaveBeenCalledWith('file-x', false)
    // Safety net does NOT consume provenance (a later watcher event still needs it).
    expect(clearSelfMoveEcho).not.toHaveBeenCalled()
  })
})
