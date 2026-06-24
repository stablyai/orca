// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('rich markdown local images', () => {
  beforeEach(() => {
    resetLocalImageSrcStateForTests()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rich-local-image')
    globalThis.window.api = {
      ...globalThis.window.api,
      fs: {
        readFile: vi.fn().mockResolvedValue({
          content: 'AA==',
          isBinary: true,
          mimeType: 'image/png'
        })
      }
    } as unknown as Window['api']
  })

  afterEach(() => {
    resetLocalImageSrcStateForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reloads persisted relative images after the markdown file context is assigned', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = new Editor({
      element: host,
      extensions: createRichMarkdownExtensions(),
      content: '![](diagram.png)',
      contentType: 'markdown'
    })

    try {
      const img = host.querySelector('img')
      expect(img).not.toBeNull()
      expect(window.api.fs.readFile).not.toHaveBeenCalled()

      setRichMarkdownImageResolverContext(editor, { filePath: '/repo/docs/readme.md' })

      await flushPromises()

      expect(window.api.fs.readFile).toHaveBeenCalledWith({
        filePath: '/repo/docs/diagram.png',
        connectionId: undefined
      })
      expect(host.querySelector('img')?.src).toBe('blob:rich-local-image')
    } finally {
      editor.destroy()
    }
  })
})
