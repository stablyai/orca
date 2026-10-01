// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { renderHook } from '@testing-library/react'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { useLocalImagePick } from './useLocalImagePick'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'
import { runSlashCommand, slashCommands } from './rich-markdown-slash-commands'

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: vi.fn().mockResolvedValue({
    results: [{ status: 'imported', destPath: '/repo/shot.png' }]
  })
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn(() => ({
      settings: { activeRuntimeEnvironmentId: null },
      folderWorkspaces: [],
      worktreesByRepo: { repo1: [{ id: 'wt-1', path: '/repo' }] }
    }))
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: vi.fn((settings) => settings)
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

const CODE_BLOCK_SOURCE = '```ts\nconst a = 1\n```\n'
// The image splits the fence; both halves keep their ``` fencing and `ts` language.
const SPLIT_CODE_BLOCK = '```ts\nconst\n```\n\n![](shot.png)\n\n```ts\n a = 1\n```'

function expectFencedSplit(target: Editor): void {
  expect(target.getMarkdown().trimEnd()).toBe(SPLIT_CODE_BLOCK)
  expect(() => target.state.doc.check()).not.toThrow()
}

let editor: Editor

function mountRichMarkdownEditor(markdown: string): Editor {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: markdown,
    contentType: 'markdown'
  })
}

function positionInsideCodeBlock(target: Editor): number {
  let pos = -1
  target.state.doc.descendants((node, nodePos) => {
    if (pos === -1 && node.isText && node.text?.startsWith('const')) {
      pos = nodePos + 'const'.length
    }
  })
  if (pos === -1) {
    throw new Error('Missing code block text')
  }
  return pos
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

describe('inserting an image while the cursor is inside a fenced code block', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
    editor = mountRichMarkdownEditor(CODE_BLOCK_SOURCE)
    editor.commands.setTextSelection(positionInsideCodeBlock(editor))
    globalThis.window.api = {
      ...globalThis.window.api,
      shell: { pickImage: vi.fn().mockResolvedValue('/tmp/shot.png') },
      ui: { saveClipboardImageAsTempFile: vi.fn().mockResolvedValue('/tmp/shot.png') }
    } as unknown as Window['api']
  })

  afterEach(() => {
    editor.destroy()
    vi.restoreAllMocks()
  })

  it('keeps both halves fenced when the toolbar picker inserts the image', async () => {
    const { result } = renderHook(() => useLocalImagePick(editor as never, '/repo/note.md', 'wt-1'))

    await result.current()
    await flushPromises()

    expectFencedSplit(editor)
  })

  it('keeps both halves fenced when the slash command inserts the image', async () => {
    const imageCommand = slashCommands.find((command) => command.id === 'image')
    expect(imageCommand).toBeDefined()
    const { result } = renderHook(() => useLocalImagePick(editor as never, '/repo/note.md', 'wt-1'))
    const from = editor.state.selection.from

    runSlashCommand(editor as never, { from, to: from }, imageCommand!, () => {
      void result.current()
    })
    await flushPromises()

    expectFencedSplit(editor)
  })

  it('keeps both halves fenced when a clipboard screenshot is pasted', async () => {
    const handled = handleRichMarkdownImagePaste({
      editor: editor as never,
      event: {
        clipboardData: { items: [{ kind: 'file', type: 'image/png' }] },
        preventDefault: vi.fn()
      } as unknown as ClipboardEvent,
      filePath: '/repo/note.md',
      worktreeId: 'wt-1'
    })
    await flushPromises()

    expect(handled).toBe(true)
    expectFencedSplit(editor)
  })

  it('still inserts the image inline when the cursor is in ordinary prose', async () => {
    editor.destroy()
    editor = mountRichMarkdownEditor('Install the extension\n')
    editor.commands.setTextSelection(13)
    const { result } = renderHook(() => useLocalImagePick(editor as never, '/repo/note.md', 'wt-1'))

    await result.current()
    await flushPromises()

    expect(editor.getMarkdown().trimEnd()).toBe('Install the ![](shot.png)extension')
  })
})
