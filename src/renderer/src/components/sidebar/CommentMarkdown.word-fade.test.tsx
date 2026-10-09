// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('removes settled word spans while keeping new words animated', () => {
  vi.useFakeTimers()
  const view = render(
    <CommentMarkdown content="first words" variant="document" growing fadeWords />
  )
  expect(view.container.querySelectorAll('[data-word]')).toHaveLength(2)
  act(() => vi.advanceTimersByTime(300))
  expect(view.container.querySelectorAll('[data-word]')).toHaveLength(0)
  view.rerender(
    <CommentMarkdown content="first words and more" variant="document" growing fadeWords />
  )
  expect(view.container.textContent).toBe('first words and more')
  expect(
    [...view.container.querySelectorAll('[data-word]')].map((word) => word.textContent)
  ).toEqual(['and', 'more'])
  act(() => vi.advanceTimersByTime(300))
  expect(view.container.querySelectorAll('[data-word]')).toHaveLength(0)
})

it('does not add pacing, repair, or fade spans to ordinary sidebar comments', () => {
  const view = render(<CommentMarkdown content="first **unfinished" variant="document" />)
  expect(view.container.textContent).toBe('first **unfinished')
  expect(view.container.querySelectorAll('[data-word], strong')).toHaveLength(0)
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
