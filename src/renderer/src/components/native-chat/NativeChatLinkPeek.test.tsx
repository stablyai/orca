// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatLinkPeek } from './NativeChatLinkPeek'

vi.mock('./native-chat-link-peek-context', async () => {
  const { createContext } = await import('react')
  return {
    NativeChatLinkPeekContext: createContext({
      githubRepo: null,
      webPreviews: { runtimeEnvironmentId: null }
    })
  }
})
vi.mock('./NativeChatGitHubLinkPeek', () => ({
  resolveGitHubPeekLink: () => null,
  NativeChatGitHubPeekBody: () => null
}))
vi.mock('./NativeChatWebLinkPeek', () => ({
  NativeChatWebPeekBody: () => <div>Page preview</div>
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function renderLink() {
  const onOpen = vi.fn((event: React.MouseEvent) => event.preventDefault())
  const view = render(
    <NativeChatLinkPeek href="https://example.com">
      <a href="https://example.com" onClick={onOpen}>
        Example
      </a>
    </NativeChatLinkPeek>
  )
  const link = screen.getByRole('link', { name: 'Example' })
  return { ...view, link, onOpen }
}

it.each([0, 400])('keeps the preview dismissed when clicking after %i ms', async (hoverTime) => {
  vi.useFakeTimers()
  const { link, onOpen } = renderLink()
  const matches = link.matches.bind(link)
  vi.spyOn(link, 'matches').mockImplementation((selector) =>
    selector === ':focus-visible' ? false : matches(selector)
  )
  fireEvent.pointerEnter(link, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(hoverTime))
  act(() => link.focus())
  fireEvent.click(link)
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByText('Page preview')).toBeNull()
  expect(document.activeElement).toBe(link)
  expect(onOpen).toHaveBeenCalledOnce()
  act(() => link.blur())
  act(() => link.focus())
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByText('Page preview')).toBeNull()
  fireEvent.pointerLeave(link, { pointerType: 'mouse' })
  fireEvent.pointerEnter(link, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByText('Page preview')).not.toBeNull()
})

it('cancels pending hover on leave and keeps an open card reachable', async () => {
  vi.useFakeTimers()
  const { link } = renderLink()
  fireEvent.pointerEnter(link, { pointerType: 'mouse' })
  fireEvent.pointerLeave(link, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByText('Page preview')).toBeNull()
  fireEvent.pointerEnter(link, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(400))
  fireEvent.pointerLeave(link, { pointerType: 'mouse' })
  fireEvent.pointerEnter(screen.getByText('Page preview'), { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByText('Page preview')).not.toBeNull()
})

it('previews keyboard focus and cancels it when focus leaves', async () => {
  vi.useFakeTimers()
  const { link } = renderLink()
  const matches = link.matches.bind(link)
  vi.spyOn(link, 'matches').mockImplementation(
    (selector) => selector === ':focus-visible' || matches(selector)
  )
  act(() => link.focus())
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByText('Page preview')).not.toBeNull()
  act(() => link.blur())
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByText('Page preview')).toBeNull()
})
