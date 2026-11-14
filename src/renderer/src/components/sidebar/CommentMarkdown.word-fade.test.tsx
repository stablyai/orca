// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const mocks = vi.hoisted(() => ({
  mermaid: vi.fn(() => {
    throw new Error('These fixtures must not render Mermaid diagrams')
  })
}))

vi.mock('./CommentMermaidBlock', () => ({ default: mocks.mermaid }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  expect(mocks.mermaid).not.toHaveBeenCalled()
  mocks.mermaid.mockClear()
})

it('keeps selected word nodes until the quote selection is cleared, including when streaming ends', () => {
  vi.useFakeTimers()
  const view = render(
    <CommentMarkdown content="selected words" variant="document" growing fadeWords />
  )
  const word = view.container.querySelector('[data-word]')
  expect(word).not.toBeNull()
  if (!word) {
    throw new Error('Missing word')
  }
  const range = document.createRange()
  range.selectNodeContents(word)
  document.getSelection()?.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(300))
  expect(word.isConnected).toBe(true)
  view.rerender(<CommentMarkdown content="selected words" variant="document" />)
  expect(word.isConnected).toBe(true)
  expect(document.getSelection()?.toString()).toBe('selected')
  document.getSelection()?.removeAllRanges()
  fireEvent(document, new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.querySelectorAll('[data-word]')).toHaveLength(0)
})
