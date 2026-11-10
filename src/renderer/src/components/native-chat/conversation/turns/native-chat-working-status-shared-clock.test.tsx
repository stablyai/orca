// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatWorkingStatus } from './NativeChatWorkingStatus'

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
          <NativeChatWorkingStatus key={index} startedAt={startedAt} />
        ))}
      </>
    )
  })
}

function elapsedLabels(): string[] {
  return Array.from(
    container.querySelectorAll('[data-native-chat-turn-status]'),
    (node) => node.textContent ?? ''
  )
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
  it('collapses every in-flight turn onto one shared visibility-gated timer', () => {
    renderTurns(3, 1_000_000)

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
})
