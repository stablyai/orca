// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPacedMarkdown } from './NativeChatPacedMarkdown'
import {
  NativeChatReplyRevealsContext,
  type NativeChatReplyReveals
} from './native-chat-reply-reveals'
import { NATIVE_CHAT_TEXT_REVEAL_DELAY_MS } from './native-chat-text-reveal'

const reveals: NativeChatReplyReveals = { begun: new Set(['reply']), drawn: new Map() }

const mermaid = vi.hoisted(() => ({ rendered: vi.fn() }))
vi.mock('@/components/sidebar/CommentMermaidBlock', () => ({
  default: ({ content: code }: { content: string }) => {
    mermaid.rendered(code)
    return <div data-testid="diagram">{code}</div>
  }
}))
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  mermaid.rendered.mockClear()
  reveals.drawn.clear()
})

it('keeps Mermaid as source until the complete received reply has been revealed', () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance'
    ]
  })
  const content = '```mermaid\ngraph TD\nA --> B\n```\n\nComplete.'
  const reply = (streaming: boolean) => (
    <NativeChatReplyRevealsContext.Provider value={reveals}>
      <NativeChatPacedMarkdown
        rowKey="reply"
        content={content}
        streaming={streaming}
        variant="document"
      />
    </NativeChatReplyRevealsContext.Provider>
  )
  const view = render(reply(true))
  act(() => vi.advanceTimersByTime(100))
  expect(mermaid.rendered).not.toHaveBeenCalled()
  view.rerender(reply(false))
  expect(mermaid.rendered).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(NATIVE_CHAT_TEXT_REVEAL_DELAY_MS - 100))
  expect(view.getByTestId('diagram').textContent).toBe('graph TD\nA --> B')
  expect(mermaid.rendered).toHaveBeenCalledWith('graph TD\nA --> B')
  const diagram = view.getByTestId('diagram')
  expect(diagram.closest('.native-chat-markdown')?.hasAttribute('data-block-fade')).toBe(false)
})

it('keeps surrounding paragraphs, links, and code mounted when Mermaid switches to a diagram', () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance'
    ]
  })
  const content =
    'Read [this](https://example.com).\n\n```ts\nconst value = 1\n```\n\n```mermaid\ngraph TD\nA --> B\n```'
  const reply = (streaming: boolean) => (
    <NativeChatReplyRevealsContext.Provider value={reveals}>
      <NativeChatPacedMarkdown
        rowKey="reply"
        content={content}
        streaming={streaming}
        variant="document"
      />
    </NativeChatReplyRevealsContext.Provider>
  )
  const view = render(reply(true))
  act(() => vi.advanceTimersByTime(NATIVE_CHAT_TEXT_REVEAL_DELAY_MS + 16))
  const paragraph = view.container.querySelector('p')
  const code = view.container.querySelector('pre')
  const link = view.getByRole('link')
  expect(paragraph).not.toBeNull()
  expect(code).not.toBeNull()
  expect(mermaid.rendered).not.toHaveBeenCalled()
  view.rerender(reply(false))
  expect(view.getByTestId('diagram')).toBeTruthy()
  expect(view.container.querySelector('p')).toBe(paragraph)
  expect(view.container.querySelector('pre')).toBe(code)
  expect(view.getByRole('link')).toBe(link)
  expect(view.container.querySelector('[data-block-fade]')).toBeNull()
})
