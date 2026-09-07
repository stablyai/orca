import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import type * as EditorAutosave from '@/components/editor/editor-autosave'

const mocks = vi.hoisted(() => ({ renameRuntimePath: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileClient>()
  return { ...actual, renameRuntimePath: mocks.renameRuntimePath }
})
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosave>()
  return { ...actual, requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined) }
})

import { useAppStore } from '@/store'
import { executeOpenEditorPathMove } from './execute-open-editor-path-move'
import { __activeEditorPathMoveCountForTests } from '@/components/editor/editor-path-move-inflight'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'
import { createExternalWatchEventHandler } from '@/hooks/useEditorExternalWatch'

const CONTEXT = {
  settings: null,
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
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    mocks.renameRuntimePath.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
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

    expect(mocks.renameRuntimePath).toHaveBeenCalledWith(CONTEXT, '/repo/a.md', '/repo/sub/a.md')
    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.filePath).toBe('/repo/sub/a.md')
    expect(moved.isDirty).toBe(true)
    expect(moved.lastKnownDiskSignature).toBe('sig-a')
    expect(useAppStore.getState().editorDrafts['/repo/sub/a.md']).toBe('unsaved work')
    // Dirty destination gets the content-verify gate + provenance.
    expect(moved.pendingLiveDiskVerification).toBe(true)
    expect(moved.pendingSelfMoveEcho?.targetPath).toBe('/repo/sub/a.md')
    // The in-flight transaction is settled (no leak).
    expect(__activeEditorPathMoveCountForTests()).toBe(0)
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
    // Disk matched the carried baseline: gate released, no false conflict banner.
    expect(moved.pendingLiveDiskVerification).toBeFalsy()
    expect(moved.externalMutation).toBeUndefined()
    expect(moved.isDirty).toBe(true)
    // Safety-net verify LEAVES the provenance so a destination watcher event
    // arriving after this read is still recognized as the move's own echo.
    expect(moved.pendingSelfMoveEcho?.targetPath).toBe('/repo/sub/a.md')
  })

  it('does not raise a false banner when the destination watcher event lands after the move', async () => {
    // Regression: the proactive verify must NOT consume the echo provenance, or
    // the real destination fs event (which on FSEvents/SSH lands after the fast
    // local read) would fall through to the immediate changed-on-disk mark.
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

    // The delayed destination create/update event finally arrives.
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
    // A distinct live session already occupies the destination id.
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

    // Forward rename then inverse rename to undo the disk move.
    expect(mocks.renameRuntimePath).toHaveBeenCalledWith(CONTEXT, '/repo/a.md', '/repo/sub/a.md')
    expect(mocks.renameRuntimePath).toHaveBeenCalledWith(CONTEXT, '/repo/sub/a.md', '/repo/a.md')
    // The stranded source session is left intact (not rekeyed).
    expect(useAppStore.getState().openFiles.map((f) => f.id)).toEqual(before)
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

    // Commit-only: no store mutation on failure.
    expect(useAppStore.getState().openFiles).toEqual(before)
    expect(__activeEditorPathMoveCountForTests()).toBe(0)
  })
})
