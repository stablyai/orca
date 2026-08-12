import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EditorAutosaveModule from '@/components/editor/editor-autosave'
import type { FsChangedPayload } from '../../../shared/types'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosaveModule>()
  return { ...actual, notifyEditorExternalFileChange: vi.fn() }
})

import { useAppStore } from '@/store'
import { notifyEditorExternalFileChange } from '@/components/editor/editor-autosave'
import { createExternalWatchEventHandler } from './useEditorExternalWatch'

const worktreePath = '\\\\wsl.localhost\\Ubuntu\\workspace\\repo'
const restoredPath = '//wsl.localhost/Ubuntu/workspace/repo/file.ts'

function payload(): FsChangedPayload {
  return {
    worktreePath,
    events: [
      { kind: 'update', absolutePath: '\\\\wsl.localhost\\Ubuntu\\workspace\\repo\\file.ts' }
    ]
  }
}

describe('WSL watcher stale-refresh reproduction', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: restoredPath,
          filePath: restoredPath,
          relativePath: 'file.ts',
          worktreeId: 'wt-wsl',
          mode: 'edit',
          isDirty: false
        }
      ],
      setExternalMutation: vi.fn()
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reloads a restored forward-UNC tab from a local backslash watcher event', () => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-wsl',
      worktreePath,
      connectionId: undefined,
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    }))

    handleFsChanged(payload())
    vi.advanceTimersByTime(100)

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-wsl',
      worktreePath,
      relativePath: 'file.ts',
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    })
    dispose()
  })

  it('keeps update aliases distinct for an SSH watcher', () => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-wsl',
      worktreePath,
      connectionId: 'ssh-1',
      runtimeEnvironmentId: null
    }))

    handleFsChanged(payload())
    vi.advanceTimersByTime(100)

    expect(notifyEditorExternalFileChange).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the same aliases distinct on a POSIX desktop', () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-wsl',
      worktreePath,
      connectionId: undefined,
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    }))

    handleFsChanged(payload())
    vi.advanceTimersByTime(100)

    expect(notifyEditorExternalFileChange).not.toHaveBeenCalled()
    dispose()
  })

  it('reloads a restored /mnt drive alias from a native-drive watcher event', () => {
    const driveRoot = 'C:\\workspace\\repo'
    const mountedPath = '//wsl.localhost/Ubuntu/mnt/c/workspace/repo/file.ts'
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: mountedPath,
          filePath: mountedPath,
          relativePath: 'file.ts',
          worktreeId: 'wt-wsl',
          mode: 'edit',
          isDirty: false
        }
      ],
      setExternalMutation: vi.fn()
    } as never)
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-wsl',
      worktreePath: driveRoot,
      connectionId: undefined,
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    }))

    handleFsChanged({
      worktreePath: driveRoot,
      events: [{ kind: 'update', absolutePath: 'C:\\workspace\\repo\\file.ts' }]
    })
    vi.advanceTimersByTime(100)

    expect(notifyEditorExternalFileChange).toHaveBeenCalledWith({
      worktreeId: 'wt-wsl',
      worktreePath: driveRoot,
      relativePath: 'file.ts',
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    })
    dispose()
  })

  it('tombstones and restores a /mnt alias from native-drive watcher events', () => {
    const driveRoot = 'C:\\workspace\\repo'
    const mountedPath = '//wsl.localhost/Ubuntu/mnt/c/workspace/repo/file.ts'
    const file = {
      id: mountedPath,
      filePath: mountedPath,
      relativePath: 'file.ts',
      worktreeId: 'wt-wsl',
      mode: 'edit' as const,
      isDirty: false,
      externalMutation: null as 'deleted' | null
    }
    const setExternalMutation = vi.fn((_id: string, mutation: 'deleted' | null) => {
      file.externalMutation = mutation
    })
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [file],
      setExternalMutation
    } as never)
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-wsl',
      worktreePath: driveRoot,
      connectionId: undefined,
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    }))

    handleFsChanged({
      worktreePath: driveRoot,
      events: [{ kind: 'delete', absolutePath: 'C:\\workspace\\repo\\file.ts' }]
    })
    vi.advanceTimersByTime(100)
    expect(setExternalMutation).toHaveBeenCalledWith(mountedPath, 'deleted')

    handleFsChanged({
      worktreePath: driveRoot,
      events: [{ kind: 'create', absolutePath: 'C:\\workspace\\repo\\file.ts' }]
    })
    expect(setExternalMutation).toHaveBeenLastCalledWith(mountedPath, null)
    dispose()
  })
})
