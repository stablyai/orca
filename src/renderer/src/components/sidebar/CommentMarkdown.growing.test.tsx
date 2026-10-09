// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import type { DocumentCodeBlockRenderer } from './comment-markdown-element-renderers'

afterEach(cleanup)

/** The rendered blocks, without the line breaks the renderer puts between them, which lay out as nothing. */
function blocksOf(container: HTMLElement): string[] {
  return Array.from(container.firstElementChild?.children ?? [], (block) => block.outerHTML)
}

const REPLY = [
  'First paragraph with **bold** and a [link](https://example.com).',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '- one',
  '- two',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  'Last paragraph.'
].join('\n')

describe('growing comment markdown', () => {
  it('renders a streamed reply to the same document as the finished one', () => {
    const whole = render(<CommentMarkdown content={REPLY} variant="document" />)
    const expected = blocksOf(whole.container)
    whole.unmount()

    const streamed = render(<CommentMarkdown content="" variant="document" growing />)
    for (let end = 5; end < REPLY.length + 5; end += 5) {
      streamed.rerender(
        <CommentMarkdown content={REPLY.slice(0, end)} variant="document" growing />
      )
    }
    // The stream ending must not redraw what is already there.
    streamed.rerender(<CommentMarkdown content={REPLY} variant="document" />)
    expect(blocksOf(streamed.container)).toEqual(expected)
  })

  it('does not render a finished block again as later text arrives', () => {
    const renderCodeBlock = vi.fn<DocumentCodeBlockRenderer>(({ children }) => (
      <pre>{children}</pre>
    ))
    const fence = '```ts\nconst a = 1\n```\n\n'
    const view = render(
      <CommentMarkdown
        content={`${fence}Next`}
        variant="document"
        renderCodeBlock={renderCodeBlock}
        growing
      />
    )
    const afterFence = renderCodeBlock.mock.calls.length
    expect(afterFence).toBeGreaterThan(0)

    let content = `${fence}Next`
    for (const more of [' paragraph', ' keeps', ' growing.\n\nAnd another.']) {
      content += more
      view.rerender(
        <CommentMarkdown
          content={content}
          variant="document"
          renderCodeBlock={renderCodeBlock}
          growing
        />
      )
    }
    expect(renderCodeBlock.mock.calls.length).toBe(afterFence)
  })
})
