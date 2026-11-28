// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotPanelStickyHeader } from './BotPanelStickyHeader'

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let observers: {
  callback: Callback
  root: Element | null
  targets: Element[]
  off: boolean
}[]

beforeEach(() => {
  observers = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private record
      constructor(callback: Callback, options?: IntersectionObserverInit) {
        this.record = {
          callback,
          root: options?.root instanceof Element ? options.root : null,
          targets: [],
          off: false
        }
        observers.push(this.record)
      }
      observe(target: Element): void {
        this.record.targets.push(target)
      }
      disconnect(): void {
        this.record.off = true
      }
    }
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(): { scroller: HTMLElement; header: HTMLElement } {
  act(() =>
    root.render(
      <div data-testid="scroller" className="relative">
        <BotPanelStickyHeader>
          <button type="button">Gear</button>
        </BotPanelStickyHeader>
        <div>Row</div>
      </div>
    )
  )
  return {
    scroller: container.querySelector<HTMLElement>('[data-testid="scroller"]')!,
    header: container.querySelector<HTMLElement>('[data-bot-panel-sticky-header]')!
  }
}

describe('BotPanelStickyHeader', () => {
  it('shows its divider only while rows are scrolled under it', () => {
    const { scroller, header } = render()
    expect(observers).toHaveLength(1)
    const [observer] = observers
    // Watches its own sentinel against the scroller, not the window.
    expect(observer.root).toBe(scroller)
    expect(observer.targets).toHaveLength(1)
    expect(observer.targets[0].parentElement).toBe(scroller)
    expect(header.hasAttribute('data-scrolled-under')).toBe(false)

    act(() => observer.callback([{ isIntersecting: false }]))
    expect(header.hasAttribute('data-scrolled-under')).toBe(true)

    act(() => observer.callback([{ isIntersecting: true }]))
    expect(header.hasAttribute('data-scrolled-under')).toBe(false)
  })

  it('keeps its content and lets the observer go on unmount', () => {
    const { header } = render()
    expect(header.textContent).toBe('Gear')
    act(() => root.unmount())
    expect(observers[0].off).toBe(true)
    root = createRoot(container)
  })
})
