// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserFind from './BrowserFind'

function createWebviewRef(): {
  ref: React.RefObject<Electron.WebviewTag | null>
  findInPage: ReturnType<typeof vi.fn>
  stopFindInPage: ReturnType<typeof vi.fn>
} {
  const findInPage = vi.fn()
  const stopFindInPage = vi.fn()
  const ref = {
    current: {
      findInPage,
      stopFindInPage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as Electron.WebviewTag
  }
  return { ref, findInPage, stopFindInPage }
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

    expect(findInPage).toHaveBeenLastCalledWith('needle', { findNext: true })
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
