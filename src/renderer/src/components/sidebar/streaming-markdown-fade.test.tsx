// @vitest-environment happy-dom

import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import { segmentWords, StreamingMarkdownFadeProvider } from './streaming-markdown-fade'

describe('streaming markdown fade', () => {
  it('segments ASCII and Unicode text by words with trailing separators', () => {
    expect(segmentWords('Hello, world!')).toEqual(['Hello, ', 'world!'])
    expect(segmentWords('Привет, мир!')).toEqual(['Привет, ', 'мир!'])
  })

  it('fades only newly appended words', () => {
    const view = render(
      <StreamingMarkdownFadeProvider>
        <CommentMarkdown content="Hello," streamingFade={{ id: 'turn', start: true }} />
      </StreamingMarkdownFadeProvider>
    )

    const firstWord = view.container.querySelector('.streaming-markdown-fade-segment')
    expect(firstWord?.textContent).toBe('Hello,')
    act(() => fireEvent.animationEnd(firstWord!))

    view.rerender(
      <StreamingMarkdownFadeProvider>
        <CommentMarkdown content="Hello, world!" streamingFade={{ id: 'turn', start: true }} />
      </StreamingMarkdownFadeProvider>
    )

    const words = Array.from(view.container.querySelectorAll('span')).filter((element) =>
      element.hasAttribute('data-streaming-fade-key')
    )
    expect(words.map((element) => element.textContent)).toEqual(['Hello, ', 'world!'])
    expect(words[0]?.classList.contains('streaming-markdown-fade-segment')).toBe(false)
    expect(words[1]?.classList.contains('streaming-markdown-fade-segment')).toBe(true)
  })

  it('keeps settled words visible across transient-to-persistent handoff', () => {
    const content = 'Final answer.'
    const view = render(
      <StreamingMarkdownFadeProvider>
        <div key="transient">
          <CommentMarkdown content={content} streamingFade={{ id: 'room-turn', start: true }} />
        </div>
      </StreamingMarkdownFadeProvider>
    )
    for (const segment of view.container.querySelectorAll('.streaming-markdown-fade-segment')) {
      act(() => fireEvent.animationEnd(segment))
    }

    view.rerender(
      <StreamingMarkdownFadeProvider>
        <section key="persistent">
          <CommentMarkdown content={content} streamingFade={{ id: 'room-turn', start: false }} />
        </section>
      </StreamingMarkdownFadeProvider>
    )

    expect(view.container.querySelector('.streaming-markdown-fade-segment')).toBeNull()
    expect(view.container.querySelector('.comment-md-p')?.textContent).toBe(content)
  })

  it('does not animate history', () => {
    const view = render(
      <StreamingMarkdownFadeProvider>
        <CommentMarkdown content="History `code`" streamingFade={{ id: 'history', start: false }} />
      </StreamingMarkdownFadeProvider>
    )

    expect(view.container.querySelector('.streaming-markdown-fade-segment')).toBeNull()
  })

  it('leaves code blocks out of the text fade', () => {
    const view = render(
      <StreamingMarkdownFadeProvider>
        <CommentMarkdown content="`code` tail" streamingFade={{ id: 'code', start: true }} />
      </StreamingMarkdownFadeProvider>
    )

    expect(
      view.container.querySelector('code')?.closest('.streaming-markdown-fade-segment')
    ).toBeNull()
    expect(
      Array.from(view.container.querySelectorAll('.streaming-markdown-fade-segment')).some(
        (element) => element.textContent === 'tail'
      )
    ).toBe(true)
  })
})
