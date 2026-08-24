// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewThreadsToggleBar } from './review-threads-toggle-bar'
import { setReviewThreadsVisible, useReviewThreadsVisible } from './review-thread-visibility'

afterEach(() => {
  cleanup()
  setReviewThreadsVisible(true)
})

describe('review thread visibility', () => {
  it('is shared across subscribers and defaults to visible', () => {
    const first = renderHook(() => useReviewThreadsVisible())
    const second = renderHook(() => useReviewThreadsVisible())
    expect(first.result.current).toBe(true)
    act(() => setReviewThreadsVisible(false))
    expect(first.result.current).toBe(false)
    expect(second.result.current).toBe(false)
  })
})

describe('ReviewThreadsToggleBar', () => {
  it('renders nothing without threads', () => {
    const { container } = render(<ReviewThreadsToggleBar threadCount={0} visible />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the count and toggles the shared visibility', async () => {
    const visibility = renderHook(() => useReviewThreadsVisible())
    render(<ReviewThreadsToggleBar threadCount={2} visible />)
    expect(screen.getByText('2 pull request conversations')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /hide comments/i }))
    expect(visibility.result.current).toBe(false)
  })

  it('offers Show comments while hidden', () => {
    render(<ReviewThreadsToggleBar threadCount={1} visible={false} />)
    expect(screen.getByRole('button', { name: /show comments/i })).toBeInTheDocument()
  })
})
