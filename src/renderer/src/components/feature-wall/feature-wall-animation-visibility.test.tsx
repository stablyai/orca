// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspacesAnimatedVisual } from './WorkspacesAnimatedVisual'

let container: HTMLDivElement
let root: Root

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function cardOrder(): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-ws-id]'))
    .map((node) => ({
      id: node.dataset.wsId ?? '',
      top: Number.parseFloat(node.style.transform.replace(/[^\d.-]/g, '')) || 0
    }))
    .sort((left, right) => left.top - right.top)
    .map((card) => card.id)
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
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

describe('feature wall animation timers', () => {
  it('pauses the workspaces card rotation while hidden and resumes without skipping', () => {
    act(() =>
      root.render(
        <TooltipProvider>
          <WorkspacesAnimatedVisual reducedMotion={false} />
        </TooltipProvider>
      )
    )
    const initialOrder = cardOrder()
    expect(vi.getTimerCount()).toBe(1)

    act(() => vi.advanceTimersByTime(3_600))
    const afterOneStep = cardOrder()
    expect(afterOneStep).not.toEqual(initialOrder)

    setDocumentVisibility('hidden')
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(3_600 * 10))
    expect(cardOrder()).toEqual(afterOneStep)

    // Revealing resumes the cycle rather than jumping a card forward.
    setDocumentVisibility('visible')
    expect(cardOrder()).toEqual(afterOneStep)
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(3_600))
    expect(cardOrder()).not.toEqual(afterOneStep)
  })
})
