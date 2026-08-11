import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: vi.fn()
}))

vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: vi.fn((state, file, worktreePath) => ({
    settings: file.runtimeEnvironmentId
      ? { activeRuntimeEnvironmentId: file.runtimeEnvironmentId }
      : state.settings,
    worktreeId: file.worktreeId,
    worktreePath:
      worktreePath ?? (file.worktreeId === 'folder:folder-1' ? '/folder-workspace' : null),
    expectedExecutionHostId: 'local'
  }))
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: vi.fn((settings, runtimeEnvironmentId) =>
    runtimeEnvironmentId ? { activeRuntimeEnvironmentId: runtimeEnvironmentId } : settings
  )
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

function editorWithRunResult(runResult: boolean) {
  const run = vi.fn(() => runResult)
  const insertContentAt = vi.fn(() => ({ run }))
  const focus = vi.fn(() => ({ insertContentAt }))
  const chain = vi.fn(() => ({ focus }))
  return { editor: { chain }, chain, focus, insertContentAt, run }
}

describe('insertRichMarkdownImageFromPath', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { useAppStore } = await import('@/store')
    vi.mocked(useAppStore.getState).mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      folderWorkspaces: [],
      openFiles: [{ id: 'file-1', worktreeId: 'wt-1' }],
      repos: [],
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/repo', hostId: 'local' }]
      },
      detectedWorktreesByRepo: {},
      projectGroups: [],
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      removedRuntimeEnvironmentIds: new Set(),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map()
    } as never)
    vi.mocked(importExternalPathsToRuntime).mockResolvedValue({
      results: [{ status: 'imported', destPath: '/repo/image.png' }]
    } as never)
  })

  it('shows an error when TipTap rejects image insertion without throwing', async () => {
    const { editor } = editorWithRunResult(false)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
      fileId: 'file-1',
      filePath: '/repo/note.md',
      sourcePath: '/tmp/image.png',
      worktreeId: 'wt-1',
      insertPos: 4
    })

    expect(toast.error).toHaveBeenCalledWith('Failed to insert image.')
  })

  it('uses folder workspace paths for runtime-owned imports', async () => {
    const { useAppStore } = await import('@/store')
    vi.mocked(useAppStore.getState).mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          executionHostId: 'runtime:env-1',
          folderPath: '/folder-workspace'
        }
      ],
      openFiles: [{ id: 'file-1', worktreeId: 'folder:folder-1', runtimeEnvironmentId: 'env-1' }],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      removedRuntimeEnvironmentIds: new Set(),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map()
    } as never)
    const { editor } = editorWithRunResult(true)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
      fileId: 'file-1',
      filePath: '/folder-workspace/note.md',
      sourcePath: '/tmp/image.png',
      worktreeId: 'folder:folder-1',
      runtimeEnvironmentId: 'env-1',
      insertPos: 4
    })

    expect(getEditorFileOperationContext).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: 'file-1', worktreeId: 'folder:folder-1' }),
      null
    )
    expect(importExternalPathsToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'folder:folder-1',
        worktreePath: '/folder-workspace'
      }),
      ['/tmp/image.png'],
      '/folder-workspace'
    )
  })

  it('inserts markdown-safe image src values for screenshot filenames with spaces', async () => {
    vi.mocked(importExternalPathsToRuntime).mockResolvedValue({
      results: [
        {
          status: 'imported',
          destPath: '/repo/Screenshot 2026-06-22 at 3.37.19 PM copy.png'
        }
      ]
    } as never)
    const { editor, insertContentAt } = editorWithRunResult(true)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
      fileId: 'file-1',
      filePath: '/repo/note.md',
      sourcePath: '/tmp/image.png',
      worktreeId: 'wt-1',
      insertPos: 4
    })

    expect(insertContentAt).toHaveBeenCalledWith(4, {
      type: 'image',
      attrs: {
        src: 'Screenshot%202026-06-22%20at%203.37.19%20PM%20copy.png'
      }
    })
  })

  it('skips editor mutation when the caller rejects the stale target after import', async () => {
    const { editor, chain } = editorWithRunResult(true)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
      fileId: 'file-1',
      filePath: '/repo/note.md',
      sourcePath: '/tmp/image.png',
      worktreeId: 'wt-1',
      insertPos: 4,
      canInsert: () => false
    })

    expect(chain).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('rejects image import after the owning file tab disappears', async () => {
    const { useAppStore } = await import('@/store')
    const current = useAppStore.getState()
    vi.mocked(useAppStore.getState).mockReturnValue({ ...current, openFiles: [] } as never)
    const { editor } = editorWithRunResult(true)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
      fileId: 'file-1',
      filePath: '/repo/note.md',
      sourcePath: '/tmp/image.png',
      worktreeId: 'wt-1',
      insertPos: 4
    })

    expect(importExternalPathsToRuntime).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Reopen the file'))
  })
})
