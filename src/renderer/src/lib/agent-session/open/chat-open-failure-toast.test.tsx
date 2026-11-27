// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from 'sonner'
import { showChatOpenUnavailable } from './chat-open-failure-toast'

const DETAIL = 'The chat tab did not appear after it was revealed.'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  render(<Toaster />)
})
afterEach(() => {
  act(() => {
    toast.dismiss()
    vi.runAllTimers()
  })
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function settle(): void {
  // Sonner removes a dismissed toast after its exit timer, across a few renders.
  for (let i = 0; i < 3; i++) {
    act(() => vi.advanceTimersByTime(1000))
  }
}

describe('chat open failure toast', () => {
  it('stays until dismissed, with its details collapsed', () => {
    act(() => showChatOpenUnavailable({ detail: DETAIL, retry: () => undefined }, 'Claude'))
    // Far past any toast timer, and past the old 5s auto-dismiss.
    act(() => vi.advanceTimersByTime(10 * 60_000))

    expect(screen.getByText("Couldn't open chat")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show details' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByText(DETAIL, { exact: false })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    settle()
    expect(screen.queryByText("Couldn't open chat")).toBeNull()
  })

  it('retries and clears the card', () => {
    const retry = vi.fn()
    act(() => showChatOpenUnavailable({ detail: DETAIL, retry }))
    act(() => vi.advanceTimersByTime(0))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    settle()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Couldn't open chat")).toBeNull()
  })

  it('gives way to a still-starting notice that reuses its id', () => {
    act(() => showChatOpenUnavailable({ detail: DETAIL, retry: () => undefined }))
    act(() => vi.advanceTimersByTime(0))
    act(() => showChatOpenUnavailable({ starting: true }))
    act(() => vi.advanceTimersByTime(0))
    expect(screen.queryByText("Couldn't open chat")).toBeNull()
    expect(screen.getByText('This chat is still starting. Try again in a moment.')).toBeTruthy()
    settle()
    settle()
    expect(screen.queryByText('This chat is still starting. Try again in a moment.')).toBeNull()
  })

  it('replaces a still-starting notice without keeping its icon', () => {
    act(() => showChatOpenUnavailable({ starting: true }))
    act(() => vi.advanceTimersByTime(0))
    act(() => showChatOpenUnavailable({ detail: DETAIL, retry: () => undefined }))
    act(() => vi.advanceTimersByTime(0))
    expect(screen.queryByText('This chat is still starting. Try again in a moment.')).toBeNull()
    const card = screen.getByText("Couldn't open chat").closest('[data-sonner-toast]')
    expect(card?.getAttribute('data-type')).not.toBe('info')
    expect(card?.querySelector('[data-icon]')).toBeNull()
  })
})
