// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatDocumentImageOrigin } from './native-chat-markdown-image-origins'
import { NativeChatMarkdown } from './NativeChatMarkdown'

const received = vi.hoisted(() => new Map<string, NativeChatDocumentImageOrigin | undefined>())
vi.mock('../media/images/NativeChatDeferredMarkdownImage', () => ({
  NativeChatDeferredMarkdownImage: (props: {
    src?: string
    origin?: NativeChatDocumentImageOrigin
  }) => {
    if (props.src) {
      received.set(props.src, props.origin)
    }
    return null
  }
}))

afterEach(() => {
  cleanup()
  received.clear()
})

describe('native-chat rendered image provenance', () => {
  it('keeps the authored anchor through cached blocks, a reference append and stream completion', () => {
    const text = 'intro\n\n  ![same](pic.png)\n\nend'
    const { rerender } = render(<NativeChatMarkdown content={text} variant="document" streaming />)
    expect(received.get('pic.png')).toEqual({ producer: 'authored-image', anchorStart: 9 })
    rerender(
      <NativeChatMarkdown content={`${text}\n\n[ref]: other.png`} variant="document" streaming />
    )
    expect(received.get('pic.png')).toEqual({ producer: 'authored-image', anchorStart: 9 })
    received.clear()
    rerender(<NativeChatMarkdown content={`${text}\n\n[ref]: other.png`} variant="document" />)
    expect(received.get('pic.png')).toEqual({ producer: 'authored-image', anchorStart: 9 })
  })

  it('delivers repaired generated-preview and mixed-HTML origins to the actual image renderer', () => {
    const { rerender } = render(
      <NativeChatMarkdown content="x~y [Chart](images/chart.png)" variant="document" streaming />
    )
    expect(received.get('#orca-native-chat-file-path=images%2Fchart.png')).toEqual({
      producer: 'authored-link-preview',
      anchorStart: 4,
      outputKey: '#orca-native-chat-file-path=images%2Fchart.png',
      outputOrdinal: 0
    })
    rerender(
      <NativeChatMarkdown
        content='<div><Unknown>x</Unknown><img src="a.png"><img src="b.png"></div>'
        variant="document"
      />
    )
    expect(received.get('a.png')).toEqual({ producer: 'html-image', anchorStart: 25 })
    expect(received.get('b.png')).toEqual({ producer: 'html-image', anchorStart: 42 })
  })
})
