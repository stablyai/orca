// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { act, renderHook } from '@testing-library/react'
import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '@/components/editor/rich-markdown-source-transport'
import { useImageInput } from './use-image-input'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

let editor: Editor | null = null

function mountComposerEditor(markdown: string): Editor {
  const host = document.createElement('div')
  document.body.appendChild(host)
  editor = new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: markdown,
    contentType: 'markdown'
  })
  return editor
}

function renderImageInput(target: Editor) {
  return renderHook(() => useImageInput({ current: target } as never, { current: false }))
}

describe('useImageInput', () => {
  afterEach(() => {
    editor?.destroy()
    editor = null
    document.body.replaceChildren()
  })

  it('splits a fenced code block instead of dissolving it when inserting an image URL', () => {
    const target = mountComposerEditor('```ts\nconst a = 1\n```\n')
    let pos = -1
    target.state.doc.descendants((node, nodePos) => {
      if (pos === -1 && node.isText && node.text?.startsWith('const')) {
        pos = nodePos + 'const'.length
      }
    })
    target.commands.setTextSelection(pos)
    const { result } = renderImageInput(target)

    act(() => result.current.setImageUrl('https://example.com/shot.png'))
    act(() => result.current.insertImageUrl())

    expect(target.getMarkdown().trimEnd()).toBe(
      '```ts\nconst\n```\n\n![](https://example.com/shot.png)\n\n```ts\n a = 1\n```'
    )
    expect(() => target.state.doc.check()).not.toThrow()
  })

  it('keeps an image URL inline when the cursor is in ordinary prose', () => {
    const target = mountComposerEditor('Install the extension\n')
    target.commands.setTextSelection(13)
    const { result } = renderImageInput(target)

    act(() => result.current.setImageUrl('https://example.com/shot.png'))
    act(() => result.current.insertImageUrl())

    expect(target.getMarkdown().trimEnd()).toBe(
      'Install the ![](https://example.com/shot.png)extension'
    )
  })
})
