// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatUiHereFeatureTipVisual } from './ChatUiHereFeatureTipVisual'

function motion(initial: boolean): (matches: boolean) => void {
  const target = new EventTarget()
  const media = {
    matches: initial,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  }
  vi.stubGlobal('matchMedia', () => media)
  return (matches) => {
    media.matches = matches
    const event = new Event('change')
    Object.defineProperty(event, 'matches', { value: matches })
    target.dispatchEvent(event)
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chat tip visual lifetime', () => {
  it('keeps one beat timer through a complete loop, stops for motion changes and retires it on unmount', () => {
    vi.useFakeTimers()
    const changeMotion = motion(false)
    const { container, unmount } = render(<ChatUiHereFeatureTipVisual />)
    const initial = container.innerHTML
    const started = Date.now()
    // Each act settles the next production beat; passing the loop boundary must make progress.
    for (let beats = 0; Date.now() - started < 13_000 && beats < 250; beats++) {
      expect(vi.getTimerCount()).toBe(1)
      act(() => vi.advanceTimersToNextTimer())
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(13_000)
    expect(container.innerHTML).not.toBe(initial)
    act(() => changeMotion(true))
    expect(vi.getTimerCount()).toBe(0)
    const finished = container.innerHTML
    act(() => vi.advanceTimersByTime(30_000))
    expect(container.innerHTML).toBe(finished)
    act(() => changeMotion(false))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts as a complete still with reduced motion and no timer', () => {
    vi.useFakeTimers()
    motion(true)
    const { container } = render(<ChatUiHereFeatureTipVisual />)
    expect(vi.getTimerCount()).toBe(0)
    expect(container.querySelectorAll('[data-on="true"]').length).toBeGreaterThan(10)
  })
})
