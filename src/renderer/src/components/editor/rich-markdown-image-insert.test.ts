// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { toast } from 'sonner'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { getConnectionIdForFile } from '@/lib/connection-context'

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null),
  getConnectionIdForFile: vi.fn(() => null)
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

const openEditors: Editor[] = []

function createRichMarkdownEditor(markdown: string): Editor {
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: markdown,
    contentType: 'markdown'
  })
  openEditors.push(editor)
  return editor
}

function editorWithRunResult(runResult: boolean, markdown = 'hello world') {
  const run = vi.fn(() => runResult)
  const insertContentAt = vi.fn(() => ({ run }))
  const focus = vi.fn(() => ({ insertContentAt }))
  const chain = vi.fn(() => ({ focus }))
  // Why: the insert path reads the real schema and document to decide whether an
  // inline image fits at the target position, so the stub borrows both.
  const { schema, state } = createRichMarkdownEditor(markdown)
  return { editor: { chain, schema, state }, chain, focus, insertContentAt, run }
}

async function stubStoreState(state: Record<string, unknown>): Promise<void> {
  const { useAppStore } = await import('@/store')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the insert path reads only these store members.
  vi.mocked(useAppStore.getState).mockReturnValue(state as never)
}

describe('insertRichMarkdownImageFromPath', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(getConnectionIdForFile).mockReturnValue(null)
    await stubStoreState({
      settings: { activeRuntimeEnvironmentId: null },
      openFiles: [],
      folderWorkspaces: [],
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', path: '/repo' }]
      }
    })
    vi.mocked(importExternalPathsToRuntime).mockResolvedValue({
      results: [{ status: 'imported', destPath: '/repo/image.png' }]
    } as never)
  })

  afterEach(() => {
    while (openEditors.length > 0) {
      openEditors.pop()?.destroy()
    }
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
    await stubStoreState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      openFiles: [],
      folderWorkspaces: [{ id: 'folder-1', folderPath: '/folder-workspace' }],
      worktreesByRepo: {}
    })
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
      '/folder-workspace',
      { access: undefined }
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

  it.each<[string, string, string | null, unknown]>([
    [
      'a local file opened outside every project',
      '/Users/me/notes/note.md',
      null,
      { kind: 'document-folder', documentPath: '/Users/me/notes/note.md' }
    ],
    ['a project file', 'note.md', null, undefined],
    ['an outside file on an SSH host', '/Users/me/notes/note.md', 'ssh-1', undefined]
  ])(
    'declares document-folder access only for %s',
    async (_label, relativePath, connectionId, access) => {
      const filePath = relativePath === 'note.md' ? '/repo/note.md' : '/Users/me/notes/note.md'
      await stubStoreState({
        settings: { activeRuntimeEnvironmentId: null },
        openFiles: [{ filePath, relativePath, worktreeId: 'wt-1' }],
        folderWorkspaces: [],
        worktreesByRepo: { repo1: [{ id: 'wt-1', path: '/repo' }] }
      })
      vi.mocked(getConnectionIdForFile).mockReturnValue(connectionId)
      const { editor } = editorWithRunResult(true)

      await insertRichMarkdownImageFromPath({
        editor: editor as never,
        filePath,
        sourcePath: '/tmp/image.png',
        worktreeId: 'wt-1',
        insertPos: 4
      })

      expect(vi.mocked(importExternalPathsToRuntime).mock.calls[0]?.[3]).toEqual({ access })
    }
  )

  it('skips editor mutation when the caller rejects the stale target after import', async () => {
    const { editor, chain } = editorWithRunResult(true)

    await insertRichMarkdownImageFromPath({
      editor: editor as never,
      filePath: '/repo/note.md',
      sourcePath: '/tmp/image.png',
      worktreeId: 'wt-1',
      insertPos: 4,
      canInsert: () => false
    })

    expect(chain).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
