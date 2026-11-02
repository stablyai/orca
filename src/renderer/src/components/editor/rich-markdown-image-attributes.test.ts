// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'

const readFile = vi.fn<Window['api']['fs']['readFile']>()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
let editor: Editor | undefined

function updateImage(attributes: Record<string, unknown>): void {
  const node = editor?.state.doc.nodeAt(1)
  if (!editor || !node) {
    throw new Error('Image node missing')
  }
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(1, undefined, { ...node.attrs, ...attributes })
  )
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  readFile.mockReset().mockResolvedValue({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
  Object.defineProperty(window, 'api', { configurable: true, value: { fs: { readFile } } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attributes')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  editor?.destroy()
  editor = undefined
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  document.body.innerHTML = ''
})

it('syncs changed and cleared metadata onto the mounted image without reloading it', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  editor = new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: '![Before](before.png "Old title")',
    contentType: 'markdown'
  })
  setRichMarkdownImageResolverContext(editor, { filePath: '/repo/docs/readme.md' })
  const image = host.querySelector('img')
  await vi.waitFor(() => expect(image?.getAttribute('src')).toBe('blob:attributes'))
  expect(image?.alt).toBe('Before')

  updateImage({ alt: 'After', title: 'New title', width: 160, height: 90 })
  expect(host.querySelector('img')).toBe(image)
  expect(image?.alt).toBe('After')
  expect(image?.title).toBe('New title')
  expect(image?.width).toBe(160)
  expect(image?.height).toBe(90)
  expect(image?.draggable).toBe(false)

  updateImage({ alt: null, title: null, width: null, height: null })
  expect(host.querySelector('img')).toBe(image)
  for (const name of ['alt', 'title', 'width', 'height']) {
    expect(image?.hasAttribute(name), name).toBe(false)
  }
  expect(image?.getAttribute('src')).toBe('blob:attributes')
  expect(readFile).toHaveBeenCalledTimes(1)
})
