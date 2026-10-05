// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { toast } from 'sonner'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'
import {
  setRichMarkdownImageResolverContext,
  type RichMarkdownImageRuntimeContext
} from './rich-markdown-image-context'

vi.mock('@/runtime/runtime-file-client', () => ({ importExternalPathsToRuntime: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn(() => ({
      settings: null,
      folderWorkspaces: [],
      worktreesByRepo: {},
      openFiles: []
    }))
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: vi.fn((settings) => settings)
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

type ImportResult = Awaited<ReturnType<typeof importExternalPathsToRuntime>>
const editors: Editor[] = []

function richEditor(markdown = 'hello world'): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: markdown,
    contentType: 'markdown'
  })
  editors.push(editor)
  return editor
}

function imported(filename = 'image.png'): ImportResult {
  return {
    results: [
      {
        sourcePath: '/tmp/image.png',
        status: 'imported',
        destPath: `/repo/${filename}`,
        kind: 'file',
        renamed: false
      }
    ]
  }
}

function pendingImport() {
  let resolve: (result: ImportResult) => void = () => {}
  const promise = new Promise<ImportResult>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function pasteImage(editor: Editor): void {
  const clipboardData = new DataTransfer()
  clipboardData.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
  const event = new ClipboardEvent('paste', { clipboardData, cancelable: true })
  expect(
    handleRichMarkdownImagePaste({ editor, event, filePath: '/repo/note.md', worktreeId: null })
  ).toBe(true)
  expect(event.defaultPrevented).toBe(true)
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 16; index++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { saveClipboardImageAsTempFile: vi.fn().mockResolvedValue('/tmp/image.png') } }
  })
  vi.mocked(importExternalPathsToRuntime).mockResolvedValue(imported())
})

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('rich Markdown asynchronous image paste', () => {
  it.each(['saving', 'importing'])(
    'reports cancellation once when the selected target changes during %s',
    async (phase) => {
      const editor = richEditor()
      editor.commands.setTextSelection({ from: 7, to: 12 })
      let completeSave: (path: string) => void = () => {}
      if (phase === 'saving') {
        vi.mocked(window.api.ui.saveClipboardImageAsTempFile).mockImplementation(
          () =>
            new Promise((resolve) => {
              completeSave = resolve
            })
        )
      }
      const pending = pendingImport()
      vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
      pasteImage(editor)
      await flushPromises()
      editor.view.dispatch(editor.state.tr.delete(7, 12))
      if (phase === 'saving') {
        completeSave('/tmp/image.png')
      } else {
        pending.resolve(imported())
      }
      await flushPromises()
      expect(editor.getMarkdown()).toBe('hello ')
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(
        phase === 'saving'
          ? 'Image insertion canceled because the destination changed. Try again.'
          : 'Image insertion canceled because the destination changed. The imported file was kept.'
      )
      expect(toast.error).not.toHaveBeenCalled()
      if (phase === 'saving') {
        expect(importExternalPathsToRuntime).not.toHaveBeenCalled()
      }
    }
  )

  it('leaves an empty clipboard result quiet', async () => {
    const editor = richEditor()
    vi.mocked(window.api.ui.saveClipboardImageAsTempFile).mockResolvedValue(null)
    pasteImage(editor)
    await flushPromises()
    expect(editor.getMarkdown()).toBe('hello world')
    expect(importExternalPathsToRuntime).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([false, true])('replaces the complete selected text, reversed=%s', async (reversed) => {
    const editor = richEditor()
    editor.commands.setTextSelection(reversed ? { from: 12, to: 7 } : { from: 7, to: 12 })
    pasteImage(editor)
    await flushPromises()
    expect(editor.getMarkdown()).toBe('hello ![](image.png)')
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(8)
    editor.state.doc.check()
  })

  it('maps edits during both clipboard saving and runtime import', async () => {
    const editor = richEditor()
    editor.commands.setTextSelection(7)
    let completeSave: (path: string) => void = () => {}
    vi.mocked(window.api.ui.saveClipboardImageAsTempFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          completeSave = resolve
        })
    )
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    pasteImage(editor)
    editor.view.dispatch(editor.state.tr.insertText('prefix ', 1))
    completeSave('/tmp/image.png')
    await flushPromises()
    editor.view.dispatch(editor.state.tr.insertText('later ', 14))
    pending.resolve(imported())
    await flushPromises()
    expect(editor.getMarkdown()).toBe('prefix hello ![](image.png)later world')
  })

  it('keeps typing after text entered at the pending paste caret', async () => {
    const editor = richEditor()
    editor.commands.setTextSelection(7)
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    pasteImage(editor)
    await flushPromises()
    editor.commands.insertContent('x')
    pending.resolve(imported())
    await flushPromises()
    editor.commands.insertContent('y')
    expect(editor.getMarkdown()).toBe('hello ![](image.png)xyworld')
  })

  it('keeps the live caret when editing another paragraph during import', async () => {
    const editor = richEditor('hello world\n\nsecond paragraph')
    editor.commands.setTextSelection(7)
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    pasteImage(editor)
    await flushPromises()
    editor.commands.setTextSelection(14)
    editor.commands.insertContent('x')
    pending.resolve(imported())
    await flushPromises()
    editor.commands.insertContent('y')
    expect(editor.getMarkdown()).toBe('hello ![](image.png)world\n\nxysecond paragraph')
  })

  it('leaves an outside input focused after image import', async () => {
    const editor = richEditor()
    editor.view.dom.focus()
    editor.commands.setTextSelection(7)
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    pasteImage(editor)
    await flushPromises()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    pending.resolve(imported())
    await flushPromises()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    expect(document.activeElement).toBe(input)
    expect(editor.getMarkdown()).toBe('hello ![](image.png)world')
  })

  it.each(['delete', 'replace'])(
    'cancels when the selected content is %s during import',
    async (operation) => {
      const editor = richEditor()
      editor.commands.setTextSelection({ from: 7, to: 12 })
      const pending = pendingImport()
      vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
      pasteImage(editor)
      await flushPromises()
      editor.view.dispatch(
        operation === 'delete'
          ? editor.state.tr.delete(7, 12)
          : editor.state.tr.insertText('new', 7, 12)
      )
      const afterEdit = editor.getMarkdown()
      pending.resolve(imported())
      await flushPromises()
      expect(editor.getMarkdown()).toBe(afterEdit)
    }
  )

  it.each([
    { from: 6, to: 8 },
    { from: 7, to: 8 },
    { from: 8, to: 10 },
    { from: 10, to: 12 },
    { from: 11, to: 13 }
  ])('cancels after partial selected-range deletion $from..$to', async ({ from, to }) => {
    const editor = richEditor()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    pasteImage(editor)
    await flushPromises()
    editor.view.dispatch(editor.state.tr.delete(from, to))
    const afterEdit = editor.getJSON()
    pending.resolve(imported())
    await flushPromises()
    expect(editor.getJSON()).toEqual(afterEdit)
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      'Image insertion canceled because the destination changed. The imported file was kept.'
    )
    editor.state.doc.check()
  })

  it('does not resurrect the selected range after partial deletion and Undo', async () => {
    const editor = richEditor()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    pasteImage(editor)
    await flushPromises()
    editor.view.dispatch(editor.state.tr.delete(8, 10))
    expect(editor.getMarkdown()).toBe('hello wld')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getMarkdown()).toBe('hello world')
    pending.resolve(imported())
    await flushPromises()
    expect(editor.getMarkdown()).toBe('hello world')
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'keeps simultaneous pastes at one caret in request order, reversed completion=%s',
    async (reversed) => {
      const editor = richEditor()
      editor.commands.setTextSelection(7)
      const first = pendingImport()
      const second = pendingImport()
      vi.mocked(importExternalPathsToRuntime)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      pasteImage(editor)
      pasteImage(editor)
      await flushPromises()
      const completeFirst = () => first.resolve(imported('first.png'))
      const completeSecond = () => second.resolve(imported('second.png'))
      const completionOrder = reversed
        ? [completeSecond, completeFirst]
        : [completeFirst, completeSecond]
      completionOrder[0]()
      await flushPromises()
      completionOrder[1]()
      await flushPromises()
      expect(editor.getMarkdown()).toBe('hello ![](first.png)![](second.png)world')
    }
  )

  it.each([false, true])(
    'keeps the remaining concurrent import after Undo, reversed completion=%s',
    async (reversed) => {
      const editor = richEditor()
      editor.commands.setTextSelection(7)
      const first = pendingImport()
      const second = pendingImport()
      vi.mocked(importExternalPathsToRuntime)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      pasteImage(editor)
      pasteImage(editor)
      await flushPromises()
      const completed = reversed ? second : first
      const remaining = reversed ? first : second
      completed.resolve(imported(reversed ? 'second.png' : 'first.png'))
      await flushPromises()
      expect(editor.commands.undo()).toBe(true)
      expect(editor.getMarkdown()).toBe('hello world')
      remaining.resolve(imported(reversed ? 'first.png' : 'second.png'))
      await flushPromises()
      expect(editor.getMarkdown()).toBe(`hello ![](${reversed ? 'first.png' : 'second.png'})world`)
      expect(toast.info).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      editor.state.doc.check()
    }
  )

  it('keeps the captured selection and live caret through pending startup focus', async () => {
    const editor = richEditor()
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    const cancelFocus = autoFocusRichEditor(editor, editor.view.dom)
    editor.view.dom.focus()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    pasteImage(editor)
    await flushPromises()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(editor.state.selection.from).toBe(1)
    pending.resolve(imported())
    await flushPromises()
    editor.commands.insertContent('continued ')
    expect(editor.getMarkdown()).toBe('continued hello ![](image.png)')
    cancelFocus()
  })

  it('keeps different pending insertion positions as another paste finishes', async () => {
    const editor = richEditor()
    const first = pendingImport()
    const second = pendingImport()
    vi.mocked(importExternalPathsToRuntime)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    editor.commands.setTextSelection(1)
    pasteImage(editor)
    editor.commands.setTextSelection(7)
    pasteImage(editor)
    await flushPromises()
    first.resolve(imported('first.png'))
    await flushPromises()
    second.resolve(imported('second.png'))
    await flushPromises()
    expect(editor.getMarkdown()).toBe('![](first.png)hello ![](second.png)world')
  })

  it('lets a later request succeed after the earlier import was canceled', async () => {
    const editor = richEditor()
    editor.commands.setTextSelection(7)
    const first = pendingImport()
    const second = pendingImport()
    vi.mocked(importExternalPathsToRuntime)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    pasteImage(editor)
    pasteImage(editor)
    await flushPromises()
    first.resolve({
      results: [{ sourcePath: '/tmp/image.png', status: 'skipped', reason: 'missing' }]
    })
    await flushPromises()
    second.resolve(imported('second.png'))
    await flushPromises()
    expect(editor.getMarkdown()).toBe('hello ![](second.png)world')
  })

  it('cancels an overlapping request after the first paste replaces its selection', async () => {
    const editor = richEditor()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const first = pendingImport()
    const second = pendingImport()
    vi.mocked(importExternalPathsToRuntime)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    pasteImage(editor)
    pasteImage(editor)
    await flushPromises()
    first.resolve(imported('first.png'))
    await flushPromises()
    second.resolve(imported('second.png'))
    await flushPromises()
    expect(editor.getMarkdown()).toBe('hello ![](first.png)')
  })

  it.each(['destroy', 'disconnect', 'disable'])(
    'ignores an imported image after editor %s',
    async (operation) => {
      const editor = richEditor()
      editor.commands.setTextSelection(7)
      const pending = pendingImport()
      vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
      pasteImage(editor)
      await flushPromises()
      if (operation === 'destroy') {
        editor.destroy()
      } else if (operation === 'disconnect') {
        editor.view.dom.remove()
      } else {
        editor.setEditable(false)
      }
      pending.resolve(imported())
      await flushPromises()
      expect(editor.getMarkdown()).toBe('hello world')
    }
  )

  it('preserves a pending selection through a no-op content reload', async () => {
    const editor = richEditor()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const pending = pendingImport()
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
    pasteImage(editor)
    await flushPromises()
    editor.commands.setContent(editor.getJSON())
    pending.resolve(imported())
    await flushPromises()
    expect(editor.getMarkdown()).toBe('hello ![](image.png)')
  })

  it.each(['file', 'worktree', 'root', 'runtime', 'connection', 'external target'])(
    'cancels before and after import when the same editor changes %s',
    async (field) => {
      for (const phase of ['saving', 'importing']) {
        const editor = richEditor()
        const runtimeContext: RichMarkdownImageRuntimeContext = {
          settings: null,
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          connectionId: null
        }
        setRichMarkdownImageResolverContext(editor, { filePath: '/repo/note.md', runtimeContext })
        editor.commands.setTextSelection({ from: 7, to: 12 })
        let completeSave: (path: string) => void = () => {}
        vi.mocked(window.api.ui.saveClipboardImageAsTempFile).mockImplementation(
          () =>
            new Promise((resolve) => {
              completeSave = resolve
            })
        )
        const pending = pendingImport()
        vi.mocked(importExternalPathsToRuntime).mockReturnValue(pending.promise)
        vi.mocked(importExternalPathsToRuntime).mockClear()
        pasteImage(editor)
        if (phase === 'importing') {
          completeSave('/tmp/image.png')
          await flushPromises()
          expect(importExternalPathsToRuntime).toHaveBeenCalledOnce()
        }
        const nextContext = { filePath: '/repo/note.md', runtimeContext: { ...runtimeContext } }
        if (field === 'file') {
          nextContext.filePath = '/repo/other.md'
        } else if (field === 'worktree') {
          nextContext.runtimeContext.worktreeId = 'wt-2'
        } else if (field === 'root') {
          nextContext.runtimeContext.worktreePath = '/other-repo'
        } else if (field === 'runtime') {
          nextContext.runtimeContext.settings = { activeRuntimeEnvironmentId: 'other-runtime' }
        } else if (field === 'connection') {
          nextContext.runtimeContext.connectionId = 'other-connection'
        } else {
          nextContext.runtimeContext.expectedExternalSshTargetId = 'other-target'
        }
        setRichMarkdownImageResolverContext(editor, nextContext)
        editor.commands.setContent(editor.getJSON())
        if (phase === 'saving') {
          completeSave('/tmp/image.png')
        } else {
          pending.resolve(imported())
        }
        await flushPromises()
        expect(editor.getMarkdown()).toBe('hello world')
        expect(importExternalPathsToRuntime).toHaveBeenCalledTimes(phase === 'saving' ? 0 : 1)
      }
    }
  )

  it('replaces selected code with an image while keeping both fence halves', async () => {
    const editor = richEditor('```js\nbefore selected after\n```')
    editor.commands.setTextSelection({ from: 8, to: 16 })
    pasteImage(editor)
    await flushPromises()
    expect(editor.getMarkdown()).toBe('```js\nbefore \n```\n\n![](image.png)\n\n```js\n after\n```')
    editor.state.doc.check()
  })

  it('replaces a selection spanning blocks without deleting surrounding text', async () => {
    const editor = richEditor('before selected\n\nselected after')
    editor.commands.setTextSelection({ from: 8, to: 26 })
    pasteImage(editor)
    await flushPromises()
    expect(editor.getMarkdown()).toBe('before ![](image.png) after')
    editor.state.doc.check()
  })
})
