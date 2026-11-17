// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import CommentMarkdown from './CommentMarkdown'

vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))
afterEach(cleanup)

function documentOf(
  content: string,
  props: { math?: boolean; fadeWords?: boolean } = {}
): HTMLElement {
  const node = document.createElement('div')
  node.innerHTML = renderToStaticMarkup(
    <CommentMarkdown content={content} math variant="document" {...props} />
  )
  return node
}

describe('native chat math', () => {
  beforeAll(async () => {
    const view = render(<CommentMarkdown content="$x$" math />)
    await waitFor(() => expect(view.container.querySelector('.katex')).not.toBeNull())
    view.unmount()
  })

  it('keeps untrusted math and HTML from creating executable content', () => {
    const node = documentOf(
      String.raw`$\href{javascript:alert(1)}{bad}$ $\htmlClass{injected}{x}$ <script>alert(1)</script><img src="x" onerror="alert(1)">`
    )
    expect(node.querySelector('script,[onerror],.injected')).toBeNull()
    expect(node.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(node.querySelectorAll('.katex')).toHaveLength(2)
  })

  it('copies selected formulas as source once and keeps surrounding prose', () => {
    const source = 'Before $x^2$ after.'
    const rendered = render(<CommentMarkdown content={source} math variant="document" />)
    const transcript = rendered.container.firstElementChild
    transcript?.setAttribute('data-native-chat-scroll', '')
    transcript?.setAttribute('data-native-chat-quote-source', '')
    const paragraph = rendered.container.querySelector('p')
    if (!paragraph) {
      throw new Error('Missing paragraph')
    }
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const setData = vi.fn()
    fireEvent.copy(paragraph, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', source)
    const glyph = paragraph.querySelector('.katex-html')
    if (!glyph) {
      throw new Error('Missing typeset formula')
    }
    range.selectNodeContents(glyph)
    selection?.removeAllRanges()
    selection?.addRange(range)
    setData.mockClear()
    fireEvent.copy(glyph, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', '$x^2$')
    selection?.removeAllRanges()
  })
})
