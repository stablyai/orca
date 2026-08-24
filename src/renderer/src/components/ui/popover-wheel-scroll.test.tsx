// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

let root: Root | null = null
let container: HTMLDivElement

/** happy-dom reports 0 for layout, so scroll geometry has to be defined per element. */
function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
}

function wheel(el: HTMLElement, deltaY: number): void {
  act(() => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
  })
}

function renderPopover(contentClassName: string, nested: boolean): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent className={contentClassName}>
          {nested ? (
            <div data-testid="viewport" style={{ overflowY: 'auto' }}>
              <div data-testid="inner">tall</div>
            </div>
          ) : (
            <div data-testid="inner">tall</div>
          )}
        </PopoverContent>
      </Popover>
    )
  })
}

describe('PopoverContent wheel shim', () => {
  let rafCallbacks: FrameRequestCallback[]

  beforeEach(() => {
    root = null
    // The shim defers the scroll write to rAF; capture and flush it explicitly.
    rafCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
    }
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  const flushFrames = (): void => {
    const pending = rafCallbacks
    rafCallbacks = []
    for (const cb of pending) {
      cb(0)
    }
  }

  it('scrolls a nested viewport when the content itself cannot scroll', () => {
    // The workspace-cleanup Filters panel: a flex column whose PopoverContent is
    // overflow-hidden, with a ScrollArea viewport above a pinned footer.
    renderPopover('popover-scroll-content', true)
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]')!
    makeScrollable(content, 800, 400)
    makeScrollable(viewport, 1000, 400)

    wheel(document.querySelector<HTMLElement>('[data-testid="inner"]')!, 120)
    flushFrames()

    expect(viewport.scrollTop).toBe(120)
    expect(content.scrollTop).toBe(0)
  })

  it('still scrolls the content itself when it is the scroller', () => {
    renderPopover('popover-scroll-content', false)
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    // Inline because happy-dom does not apply the stylesheet; in the app
    // `.popover-scroll-content` already sets `overflow-y: auto` (main.css).
    content.style.overflowY = 'auto'
    makeScrollable(content, 1000, 400)

    wheel(document.querySelector<HTMLElement>('[data-testid="inner"]')!, 120)
    flushFrames()

    expect(content.scrollTop).toBe(120)
  })

  it('leaves popovers that did not opt in alone', () => {
    renderPopover('', true)
    const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]')!
    makeScrollable(viewport, 1000, 400)

    wheel(document.querySelector<HTMLElement>('[data-testid="inner"]')!, 120)
    flushFrames()

    expect(viewport.scrollTop).toBe(0)
  })

  it('ignores vertically clipped elements and horizontal-only scrollers', () => {
    renderPopover('popover-scroll-content', true)
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]')!
    content.style.overflowY = 'hidden'
    viewport.style.overflowY = 'hidden'
    viewport.style.overflowX = 'auto'
    makeScrollable(content, 1000, 400)
    makeScrollable(viewport, 1000, 400)
    Object.defineProperty(viewport, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(viewport, 'clientWidth', { value: 400, configurable: true })

    wheel(document.querySelector<HTMLElement>('[data-testid="inner"]')!, 120)
    flushFrames()

    expect(content.scrollTop).toBe(0)
    expect(viewport.scrollTop).toBe(0)
  })

  it('does nothing when no element in the target chain can scroll', () => {
    renderPopover('popover-scroll-content', true)
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]')!
    content.style.overflowY = 'hidden'
    viewport.style.overflowY = 'hidden'
    makeScrollable(content, 1000, 400)
    makeScrollable(viewport, 1000, 400)

    wheel(document.querySelector<HTMLElement>('[data-testid="inner"]')!, 120)
    flushFrames()

    expect(content.scrollTop).toBe(0)
    expect(viewport.scrollTop).toBe(0)
  })

  it('runs for the shim-only marker, which carries no styling', () => {
    // The workspace-cleanup Filters panel needs the wheel shim but must NOT inherit
    // `.popover-scroll-content`'s 15rem max-height, which would crush its 471px column.
    renderPopover('popover-wheel-scroll', true)
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]')!
    viewport.style.overflowY = 'auto'
    makeScrollable(content, 400, 400)
    makeScrollable(viewport, 1000, 400)

    wheel(document.querySelector<HTMLElement>('[data-testid="inner"]')!, 120)
    flushFrames()

    expect(viewport.scrollTop).toBe(120)
  })
})
