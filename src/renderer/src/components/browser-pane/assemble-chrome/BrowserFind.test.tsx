// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserFind from './BrowserFind'

function createWebviewRef(): {
  ref: React.RefObject<Electron.WebviewTag | null>
  findInPage: ReturnType<typeof vi.fn>
  stopFindInPage: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
} {
  const findInPage = vi.fn()
  const stopFindInPage = vi.fn()
  // Track listeners independently of ref.current to verify cleanup after a guest swap.
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()
  const ref = {
    current: {
      findInPage,
      stopFindInPage,
      addEventListener,
      removeEventListener
    } as unknown as Electron.WebviewTag
  }
  return { ref, findInPage, stopFindInPage, addEventListener, removeEventListener }
}

function openFindWithQuery(query: string): ReturnType<typeof createWebviewRef> {
  const webview = createWebviewRef()
  vi.useFakeTimers()
  render(<BrowserFind isOpen onClose={vi.fn()} webviewRef={webview.ref} />)
  fireEvent.change(screen.getByPlaceholderText('Find in page...'), { target: { value: query } })
  act(() => {
    vi.advanceTimersByTime(250)
  })
  return webview
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BrowserFind session flags', () => {
  it('starts a new find session when the query changes', () => {
    const { findInPage } = openFindWithQuery('needle')

    expect(findInPage).toHaveBeenCalledExactlyOnceWith('needle', { findNext: true })
    findInPage.mockClear()

    fireEvent.change(screen.getByPlaceholderText('Find in page...'), {
      target: { value: 'replacement' }
    })
    act(() => vi.advanceTimersByTime(250))

    expect(findInPage).toHaveBeenCalledExactlyOnceWith('replacement', { findNext: true })
  })

  it('advances forward as a follow-up request, not a new session', () => {
    const { findInPage } = openFindWithQuery('needle')
    findInPage.mockClear()

    fireEvent.click(screen.getByTitle('Next match'))

    expect(findInPage).toHaveBeenCalledExactlyOnceWith('needle', {
      forward: true,
      findNext: false
    })
  })

  it('advances backward as a follow-up request, not a new session', () => {
    const { findInPage } = openFindWithQuery('needle')
    findInPage.mockClear()

    fireEvent.click(screen.getByTitle('Previous match'))

    expect(findInPage).toHaveBeenCalledExactlyOnceWith('needle', {
      forward: false,
      findNext: false
    })
  })

  it('treats Enter and Shift+Enter as follow-up requests in both directions', () => {
    const { findInPage } = openFindWithQuery('needle')
    findInPage.mockClear()
    const input = screen.getByPlaceholderText('Find in page...')

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(findInPage.mock.calls).toEqual([
      ['needle', { forward: true, findNext: false }],
      ['needle', { forward: false, findNext: false }]
    ])
  })

  it('starts the new query when Enter is pressed before its debounce settles', () => {
    const webview = createWebviewRef()
    vi.useFakeTimers()
    render(<BrowserFind isOpen onClose={vi.fn()} webviewRef={webview.ref} />)
    const input = screen.getByPlaceholderText('Find in page...')

    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(webview.findInPage).toHaveBeenCalledExactlyOnceWith('needle', {
      forward: true,
      findNext: true
    })
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(webview.findInPage).toHaveBeenCalledTimes(1)
  })
})

// Guest replacement preserves the pane mount; only generation changes can rebind the listener.
describe('BrowserFind listener rebinding', () => {
  it('moves the found-in-page listener onto a guest swapped in under the same mount', () => {
    const first = createWebviewRef()
    const { rerender } = render(
      <BrowserFind isOpen onClose={vi.fn()} webviewRef={first.ref} guestGeneration={1} />
    )
    const staleListener = first.addEventListener.mock.calls.find(
      (call) => call[0] === 'found-in-page'
    )?.[1]
    expect(staleListener).toBeTypeOf('function')

    const second = createWebviewRef()
    first.ref.current = second.ref.current
    rerender(<BrowserFind isOpen onClose={vi.fn()} webviewRef={first.ref} guestGeneration={2} />)

    expect(second.addEventListener).toHaveBeenCalledWith('found-in-page', expect.any(Function))
    // The host may retain the old guest; leaving its listener would keep updating a bar that no longer owns it.
    expect(first.removeEventListener).toHaveBeenCalledWith('found-in-page', staleListener)
  })
})
