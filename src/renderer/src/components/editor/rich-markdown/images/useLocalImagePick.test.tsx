// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { importExternalPathsToRuntime } from '@/runtime/files/imports/runtime-file-import-client'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { useLocalImagePick } from './useLocalImagePick'

vi.mock('@/runtime/files/imports/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: vi.fn()
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: vi.fn(() => ({
      settings: null,
      folderWorkspaces: [],
      worktreesByRepo: {},
      openFiles: []
    }))
  }
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

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
})
