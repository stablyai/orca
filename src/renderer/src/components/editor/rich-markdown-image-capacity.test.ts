// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { blobUrlCache } from './local-image-src-cache'
import { prewarmMarkdownPreviewLocalImages } from './markdown-preview-local-images'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'

const editors: Editor[] = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const readFile = vi.fn(async () => ({
  content:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
  isBinary: true,
  mimeType: 'image/png'
}))
let nextUrl = 0

function mountImages(count: number) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: Array.from({ length: count }, (_, index) => `![](image-${index}.png)`).join('\n\n'),
    contentType: 'markdown'
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath: '/repo/docs/readme.md' })
  return { editor, host }
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  readFile.mockClear()
  nextUrl = 0
  Object.defineProperty(window, 'api', { value: { fs: { readFile } }, configurable: true })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:capacity-${nextUrl++}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) {
      editor.destroy()
    }
  }
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  document.body.innerHTML = ''
})

it('displays every image in a 101-image document within the byte budget', async () => {
  const view = mountImages(101)
  await vi.waitFor(() => {
    expect(view.host.querySelectorAll('img[src]')).toHaveLength(101)
  })
  expect(readFile).toHaveBeenCalledTimes(101)
  expect(blobUrlCache.size).toBe(101)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  const prewarm = prewarmMarkdownPreviewLocalImages('![](unleased.png)', '/repo/docs/readme.md')
  await prewarm.done
  expect(blobUrlCache.size).toBe(101)
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  view.editor.destroy()
  expect(blobUrlCache.size).toBe(100)
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
})

it('keeps an entirely unleased prewarm within the entry target', async () => {
  const prewarm = prewarmMarkdownPreviewLocalImages(
    Array.from({ length: 101 }, (_, index) => `![](prewarm-${index}.png)`).join('\n\n'),
    '/repo/docs/readme.md',
    { limit: 101 }
  )
  await prewarm.done
  expect(readFile).toHaveBeenCalledTimes(101)
  expect(blobUrlCache.size).toBe(100)
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
})
