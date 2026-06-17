// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import {
  createRichMarkdownExtensions,
  notifyRichMarkdownImageResolverChanged,
  type RichMarkdownImageSrcResolver
} from './rich-markdown-extensions'

function nextMicrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  queueMicrotask(resolve)
  return promise
}

const TRELLO_IMAGE_SRC = 'https://api.trello.com/1/cards/card-1/attachments/a-1/download/image.png'

describe('rich markdown Trello image node view', () => {
  it('uses the custom resolver for Trello markdown images', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const resolver = vi.fn(async () => 'blob:trello-image')
    const markdown = `![Screenshot](${TRELLO_IMAGE_SRC})`
    const editor = new Editor({
      element,
      extensions: createRichMarkdownExtensions({ resolveImageSrc: resolver }),
      content: encodeRawMarkdownHtmlForRichEditor(markdown),
      contentType: 'markdown'
    })

    await nextMicrotask()

    expect(resolver).toHaveBeenCalledWith(TRELLO_IMAGE_SRC)
    expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:trello-image')
    expect(editor.getMarkdown()).toBe(markdown)
    editor.destroy()
  })

  it('uses a ref-backed resolver and picks up identity changes on reparse', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)

    // Simulate the ref-backed stable-resolver pattern used by
    // LinearIssueMarkdownDescriptionEditor: a mutable ref whose current value
    // is read by a stable resolver function.
    let currentResolver: RichMarkdownImageSrcResolver | undefined
    const stableResolver: RichMarkdownImageSrcResolver = (src) =>
      currentResolver?.(src) ?? Promise.resolve(undefined)

    currentResolver = vi.fn(async () => 'blob:account-1')
    const markdown = `![Screenshot](${TRELLO_IMAGE_SRC})`
    const editor = new Editor({
      element,
      extensions: createRichMarkdownExtensions({ resolveImageSrc: stableResolver }),
      content: encodeRawMarkdownHtmlForRichEditor(markdown),
      contentType: 'markdown'
    })
    await nextMicrotask()

    expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:account-1')

    // Switch identity — the nodeview should pick up the new resolver when the
    // editor notifies image node views after a resolver/account change.
    currentResolver = vi.fn(async () => 'blob:account-2')
    notifyRichMarkdownImageResolverChanged()
    await nextMicrotask()

    expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:account-2')
    editor.destroy()
  })

  it('preserves empty alt text through the image node view', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const resolver = vi.fn(async () => 'blob:trello-no-alt')
    const markdown = `![](${TRELLO_IMAGE_SRC})`
    const editor = new Editor({
      element,
      extensions: createRichMarkdownExtensions({ resolveImageSrc: resolver }),
      content: encodeRawMarkdownHtmlForRichEditor(markdown),
      contentType: 'markdown'
    })

    await nextMicrotask()

    expect(resolver).toHaveBeenCalledWith(TRELLO_IMAGE_SRC)
    expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:trello-no-alt')
    // The markdown round-trip should preserve the empty alt text.
    expect(editor.getMarkdown()).toBe(markdown)
    editor.destroy()
  })
})
