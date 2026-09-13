// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatNativeChatDuration, NativeChatWorkingStatus } from './NativeChatWorkingStatus'

let container: HTMLDivElement
let root: Root

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function renderTurns(count: number, startedAt: number): void {
  act(() => {
    root.render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <NativeChatWorkingStatus key={index} startedAt={startedAt} thinking={false} />
        ))}
      </>
    )
  })
}

function elapsedLabels(): string[] {
  return Array.from(container.querySelectorAll('[aria-label]'), (node) => node.textContent ?? '')
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  setDocumentVisibility('visible')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setDocumentVisibility('visible')
  vi.useRealTimers()
})

describe('native chat working status elapsed clock', () => {
  it.each([
    [0, '0s'],
    [59, '59s'],
    [60, '1m 0s'],
    [69, '1m 9s'],
    [3_725, '1h 2m 5s']
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatNativeChatDuration(seconds)).toBe(expected)
  })

  it('renders the compact duration in the completed status label', () => {
    act(() => {
      root.render(
        <NativeChatWorkingStatus startedAt={1_000_000} thinking={false} workedSeconds={69} />
      )
    })

    expect(elapsedLabels()).toEqual(['Worked for 1m 9s'])
  })

  it('collapses every in-flight turn onto one shared visibility-gated timer', () => {
    renderTurns(3, 1_000_000)

    // One shared 1s clock for all three turns, not one interval per turn.
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(3_000))
    expect(elapsedLabels()).toEqual(['Working for 3s', 'Working for 3s', 'Working for 3s'])
  })

  it('stops ticking while hidden and re-syncs the elapsed value on return', () => {
    renderTurns(1, 1_000_000)
    act(() => vi.advanceTimersByTime(3_000))
    expect(elapsedLabels()).toEqual(['Working for 3s'])

    setDocumentVisibility('hidden')
    expect(vi.getTimerCount()).toBe(0)

    // A minute of hidden wall-clock: no callbacks, no commits, label frozen.
    act(() => vi.advanceTimersByTime(60_000))
    expect(elapsedLabels()).toEqual(['Working for 3s'])

    // Returning re-derives elapsed from startedAt, so nothing was lost.
    setDocumentVisibility('visible')
    expect(elapsedLabels()).toEqual(['Working for 1m 3s'])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('holds no timer for a thinking turn or a completed turn', () => {
    act(() => {
      root.render(
        <>
          <NativeChatWorkingStatus startedAt={1_000_000} thinking />
          <NativeChatWorkingStatus startedAt={1_000_000} thinking={false} workedSeconds={12} />
        </>
      )
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
