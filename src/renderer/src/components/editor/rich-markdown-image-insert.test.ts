import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => 'ssh-1')
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
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', path: '/repo' }]
      }
    } as never)
    vi.mocked(importExternalPathsToRuntime).mockResolvedValue({
      results: [{ status: 'imported', destPath: '/repo/image.png' }]
    } as never)
  })

  it('shows an error when TipTap rejects image insertion without throwing', async () => {
    const { editor } = editorWithRunResult(false)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
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
      folderWorkspaces: [{ id: 'folder-1', folderPath: '/folder-workspace' }],
      worktreesByRepo: {}
    } as never)
    const { editor } = editorWithRunResult(true)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
      filePath: '/folder-workspace/note.md',
      sourcePath: '/tmp/image.png',
      worktreeId: 'folder:folder-1',
      runtimeEnvironmentId: 'env-1',
      insertPos: 4
    })

    expect(importExternalPathsToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'folder:folder-1',
        worktreePath: '/folder-workspace'
      }),
      ['/tmp/image.png'],
      '/folder-workspace'
    )
  })
})
