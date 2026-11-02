// @vitest-environment happy-dom
import type * as StoreModule from '@/store'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import type * as ImageBlobPng from '@/lib/image-blob-png'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { DOMParser } from '@tiptap/pm/model'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null,
  getConnectionIdForFile: () => null
}))
vi.mock('@/lib/image-blob-png', async (original) => {
  const actual = await original<typeof ImageBlobPng>()
  return { ...actual, convertImageBlobToPng: async (blob: Blob) => blob }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const { useAppStore: store } = await vi.importActual<typeof StoreModule>('@/store')

const editors: Editor[] = []
const saves = vi.fn()
const imports = vi.fn()
const ownBlob = (id: string): string => `blob:${window.location.origin}/${id}`

function createEditor(): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, Image.configure({ inline: true }), Markdown],
    content: 'left right',
    contentType: 'markdown'
  })
  editors.push(editor)
  editor.commands.setTextSelection(6)
  return editor
}

function paste(editor: Editor, html: string, worktreeId = ''): void {
  const container = document.createElement('div')
  container.innerHTML = html
  const slice = DOMParser.fromSchema(editor.schema).parseSlice(container)
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/html', html)
  const event = new ClipboardEvent('paste', { clipboardData, cancelable: true })
  if (
    !handleRichMarkdownPaste({
      editor,
      event,
      filePath: '/notes/note.md',
      worktreeId,
      slice,
      view: editor.view
    })
  ) {
    editor.view.dispatch(editor.state.tr.replaceSelection(slice).setMeta('uiEvent', 'paste'))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAppStore.getState).mockReturnValue(store.getInitialState())
  let next = 0
  saves.mockImplementation(async () => ({ ok: true, result: `/tmp/pasted-${++next}.png` }))
  imports.mockImplementation(async ({ sourcePaths }: { sourcePaths: string[] }) => ({
    results: sourcePaths.map((sourcePath) => ({
      status: 'imported',
      kind: 'file',
      sourcePath,
      destPath: `/notes/${sourcePath.split('/').at(-1)}`,
      renamed: false
    }))
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runtime: { call: saves }, fs: { importExternalPaths: imports } }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (src: string) => ({
      ok: true,
      blob: async () => new Blob([src], { type: 'image/png' })
    }))
  )
})

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('inserts the paste immediately, then saves blob images beside the note', async () => {
  const editor = createEditor()
  paste(
    editor,
    `<p>caption <strong>bold</strong><img src="${ownBlob('a')}" alt="first" title="one"> between <img src="${ownBlob('b')}" alt="second"></p>`
  )
  expect(editor.getMarkdown()).toContain('**bold**')
  await vi.waitFor(() => expect(editor.getMarkdown()).not.toContain('blob:'))
  const markdown = editor.getMarkdown()
  expect(markdown).toContain('![first](pasted-1.png "one")')
  expect(markdown).toContain('![second](pasted-2.png)')
  expect(saves.mock.calls.map(([args]) => args.params.contentBase64)).toEqual([
    btoa(ownBlob('a')),
    btoa(ownBlob('b'))
  ])
  expect(imports.mock.calls[0]?.[0]).toMatchObject({ destDir: '/notes' })
  expect(editor.commands.undo()).toBe(true)
  expect(editor.getMarkdown()).toBe('left right')
})

it('keeps the pasted text and the remaining images when one image cannot be read', async () => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (input === ownBlob('gone')) {
      throw new TypeError('Failed to fetch')
    }
    return new Response(new Blob(['ok'], { type: 'image/png' }))
  })
  const editor = createEditor()
  paste(
    editor,
    `<p>kept text <img src="${ownBlob('gone')}" alt="gone"><img src="${ownBlob('ok')}" alt="ok"></p>`
  )
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  const markdown = editor.getMarkdown()
  expect(markdown).toContain('kept text')
  expect(markdown).toContain(`![gone](${ownBlob('gone')})`)
  expect(markdown).toContain('![ok](pasted-1.png)')
})

it('leaves blob images from other origins to the native paste', async () => {
  const editor = createEditor()
  paste(editor, '<p>external <img src="blob:https://example.com/abc" alt="x"></p>')
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
  expect(editor.getMarkdown()).toContain('external ![x](blob:https://example.com/abc)')
})

it('keeps the native paste without importing to a replaced document after temp save', async () => {
  store.setState(store.getInitialState(), true)
  const source: OpenFile = {
    id: 'blob-note',
    worktreeId: 'wt-blob',
    filePath: '/notes/note.md',
    relativePath: 'note.md',
    mode: 'edit',
    language: 'markdown',
    isDirty: false
  }
  store.setState({
    openFiles: [source],
    repos: [{ ...TEST_REPO, path: '/notes', executionHostId: 'local' }],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({
          id: source.worktreeId,
          repoId: TEST_REPO.id,
          path: '/notes',
          hostId: 'local'
        })
      ]
    }
  })
  vi.mocked(useAppStore.getState).mockImplementation(store.getState)
  let finish!: () => void
  const paused = new Promise<void>((resolve) => {
    finish = resolve
  })
  saves.mockImplementation(async () => {
    await paused
    return { ok: true, result: '/tmp/pasted.png' }
  })
  const editor = createEditor()
  paste(
    editor,
    `<p>kept text <img src="${ownBlob('pending')}" alt="pending"></p>`,
    source.worktreeId
  )
  await vi.waitFor(() => expect(saves).toHaveBeenCalledOnce())
  store.setState({
    openFiles: [{ ...source, filePath: '/notes/replacement.md', relativePath: 'replacement.md' }]
  })
  finish()
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
  expect(imports).not.toHaveBeenCalled()
  expect(editor.getMarkdown()).toContain(`kept text ![pending](${ownBlob('pending')})`)
})
