// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOADING_AFFORDANCE_DELAY_MS, useDeferredLoadingState } from './use-deferred-loading-state'
import { ResourceManagerSkeleton } from './ResourceManagerSkeleton'

function Probe({ pending }: { pending: boolean }): React.JSX.Element {
  return <span>{useDeferredLoadingState(pending) ? 'visible' : 'hidden'}</span>
}

describe('useDeferredLoadingState', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  const render = (pending: boolean): void => {
    act(() => {
      root.render(<Probe pending={pending} />)
    })
  }
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('stays hidden while the wait is short', () => {
    render(true)
    expect(container.textContent).toBe('hidden')
    advance(LOADING_AFFORDANCE_DELAY_MS - 1)
    expect(container.textContent).toBe('hidden')
  })

  it('never becomes visible when the wait resolves inside the delay', () => {
    render(true)
    advance(LOADING_AFFORDANCE_DELAY_MS - 50)
    render(false)
    advance(LOADING_AFFORDANCE_DELAY_MS * 3)
    expect(container.textContent).toBe('hidden')
  })

  it('appears once the wait is long enough to be worth showing', () => {
    render(true)
    advance(LOADING_AFFORDANCE_DELAY_MS)
    expect(container.textContent).toBe('visible')
  })

  it('clears as soon as the wait ends', () => {
    render(true)
    advance(LOADING_AFFORDANCE_DELAY_MS)
    expect(container.textContent).toBe('visible')
    render(false)
    expect(container.textContent).toBe('hidden')
  })

  it('restarts the delay for a second wait', () => {
    render(true)
    advance(LOADING_AFFORDANCE_DELAY_MS)
    render(false)
    render(true)
    expect(container.textContent).toBe('hidden')
    advance(LOADING_AFFORDANCE_DELAY_MS)
    expect(container.textContent).toBe('visible')
  })
})

describe('ResourceManagerSkeleton', () => {
  it('renders placeholder rows in the metric grid', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<ResourceManagerSkeleton />)
    })
    // Why: the placeholders must occupy the same grid the rows land in, or the
    // content still shifts — just one frame later.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(5)
    expect(container.querySelector('[aria-hidden]')).not.toBeNull()
    act(() => {
      root.unmount()
    })
    container.remove()
  })
})
