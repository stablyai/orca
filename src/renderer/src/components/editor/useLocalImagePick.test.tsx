// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { useLocalImagePick } from './useLocalImagePick'

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
type PickerContext = {
  editor: Editor | null
  filePath: string
  worktreeId: string | null
  runtimeId: string | null
}
const editors: Editor[] = []

function richEditor(): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: 'hello world',
    contentType: 'markdown'
  })
  editor.commands.setTextSelection({ from: 7, to: 12 })
  editors.push(editor)
  return editor
}

function mountPicker(editor: Editor) {
  const initialProps: PickerContext = {
    editor,
    filePath: '/repo/note.md',
    worktreeId: null,
    runtimeId: null
  }
  const hook = renderHook(
    ({ editor, filePath, worktreeId, runtimeId }) =>
      useLocalImagePick(editor, filePath, worktreeId, runtimeId),
    { initialProps }
  )
  return { ...hook, initialProps }
}

function pendingPicker() {
  let resolve: (path: string | null) => void = () => {}
  const promise = new Promise<string | null>((complete) => {
    resolve = complete
  })
  vi.mocked(window.api.shell.pickImage).mockReturnValue(promise)
  return { resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { shell: { pickImage: vi.fn().mockResolvedValue('/tmp/image.png') } }
  })
  vi.mocked(importExternalPathsToRuntime).mockResolvedValue({
    results: [
      {
        sourcePath: '/tmp/image.png',
        status: 'imported',
        destPath: '/repo/image.png',
        kind: 'file',
        renamed: false
      }
    ]
  })
})

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('local image picker pending insertion', () => {
  it('replaces the selected range after it moves while the picker is open', async () => {
    const editor = richEditor()
    const { result, unmount } = mountPicker(editor)
    const pending = pendingPicker()
    const request = result.current()
    editor.view.dispatch(editor.state.tr.insertText('prefix ', 1))
    pending.resolve('/tmp/image.png')
    await request
    expect(editor.getMarkdown()).toBe('prefix hello ![](image.png)')
    unmount()
  })

  it('keeps the live caret and outside control focus after the picker completes', async () => {
    const editor = richEditor()
    editor.view.dom.focus()
    const { result, unmount } = mountPicker(editor)
    const pending = pendingPicker()
    const request = result.current()
    editor.commands.setTextSelection(1)
    editor.commands.insertContent('x')
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    pending.resolve('/tmp/image.png')
    await request
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    expect(document.activeElement).toBe(input)
    editor.commands.insertContent('y')
    expect(editor.getMarkdown()).toBe('xyhello ![](image.png)')
    unmount()
  })

  it.each(['editor', 'filePath', 'worktreeId', 'runtimeId'])(
    'cancels before import when %s changes',
    async (field) => {
      const editor = richEditor()
      const { result, rerender, unmount, initialProps } = mountPicker(editor)
      const pending = pendingPicker()
      const request = result.current()
      const nextProps = { ...initialProps }
      if (field === 'editor') {
        nextProps.editor = richEditor()
      } else if (field === 'filePath') {
        nextProps.filePath = '/repo/other.md'
      } else if (field === 'worktreeId') {
        nextProps.worktreeId = 'folder:other'
      } else {
        nextProps.runtimeId = 'other-runtime'
      }
      rerender(nextProps)
      pending.resolve('/tmp/image.png')
      await request
      expect(importExternalPathsToRuntime).not.toHaveBeenCalled()
      expect(editor.getMarkdown()).toBe('hello world')
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(
        'Image insertion canceled because the destination changed. Try again.'
      )
      unmount()
    }
  )

  it('cancels after import starts when the current editor is removed', async () => {
    const editor = richEditor()
    const { result, rerender, unmount, initialProps } = mountPicker(editor)
    let completeImport: (result: ImportResult) => void = () => {}
    vi.mocked(importExternalPathsToRuntime).mockReturnValue(
      new Promise((resolve) => {
        completeImport = resolve
      })
    )
    const request = result.current()
    await Promise.resolve()
    expect(importExternalPathsToRuntime).toHaveBeenCalledOnce()
    rerender({ ...initialProps, editor: null })
    completeImport({
      results: [
        {
          sourcePath: '/tmp/image.png',
          status: 'imported',
          destPath: '/repo/image.png',
          kind: 'file',
          renamed: false
        }
      ]
    })
    await request
    expect(editor.getMarkdown()).toBe('hello world')
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      'Image insertion canceled because the destination changed. The imported file was kept.'
    )
    unmount()
  })

  it('cancels on unmount before a picker result arrives', async () => {
    const editor = richEditor()
    const { result, unmount } = mountPicker(editor)
    const pending = pendingPicker()
    const request = result.current()
    unmount()
    pending.resolve('/tmp/image.png')
    await request
    expect(importExternalPathsToRuntime).not.toHaveBeenCalled()
    expect(editor.getMarkdown()).toBe('hello world')
  })

  it.each(['cancel', 'failure'])(
    'releases its transaction listener on picker %s',
    async (operation) => {
      const editor = richEditor()
      const off = vi.spyOn(editor, 'off')
      const { result, unmount } = mountPicker(editor)
      if (operation === 'cancel') {
        vi.mocked(window.api.shell.pickImage).mockResolvedValue(null)
      } else {
        vi.mocked(window.api.shell.pickImage).mockRejectedValue(new Error('Picker failed'))
      }
      await result.current()
      expect(off).toHaveBeenCalledWith('transaction', expect.any(Function))
      expect(importExternalPathsToRuntime).not.toHaveBeenCalled()
      if (operation === 'failure') {
        expect(toast.error).toHaveBeenCalledWith('Picker failed')
      } else {
        expect(toast.error).not.toHaveBeenCalled()
      }
      expect(toast.info).not.toHaveBeenCalled()
      unmount()
    }
  )
})
