// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useClearOfFloatingTrigger } from './use-clear-of-floating-trigger'

// Layout is faked: each element's rect is what the test says, and a ResizeObserver reports only the
// elements it watches, as the browser does.
const rects = new Map<Element, { top: number; height: number }>()
const watchers = new Set<{ targets: Set<Element>; callback: () => void }>()

class FakeResizeObserver {
  private readonly watcher: { targets: Set<Element>; callback: () => void }
  constructor(callback: () => void) {
    this.watcher = { targets: new Set(), callback }
    watchers.add(this.watcher)
  }
  observe(target: Element): void {
    this.watcher.targets.add(target)
  }
  unobserve(target: Element): void {
    this.watcher.targets.delete(target)
  }
  // As in the browser, it stops watching everything but can watch again.
  disconnect(): void {
    this.watcher.targets.clear()
  }
}

function place(element: Element, top: number, height: number): void {
  rects.set(element, { top, height })
}

/** The browser's report that `element` changed size. */
function resized(element: Element): void {
  act(() => {
    for (const watcher of watchers) {
      if (watcher.targets.has(element)) {
        watcher.callback()
      }
    }
  })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const rect = rects.get(this) ?? { top: 0, height: 0 }
    return new DOMRect(0, rect.top, 300, rect.height)
  })
})

afterEach(() => {
  cleanup()
  rects.clear()
  watchers.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Column(): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const lift = useClearOfFloatingTrigger(box)
  return (
    <div data-testid="column">
      <div data-testid="activity" />
      <div style={{ display: 'contents' }}>
        <div ref={box} data-testid="box" data-lift={lift} />
      </div>
    </div>
  )
}

it('rises clear of the floating button once Activity above it fills in and pushes it down', () => {
  const trigger = document.createElement('div')
  trigger.setAttribute('data-floating-terminal-toggle', '')
  document.body.append(trigger)
  place(trigger, 760, 36)
  // Activity is still being read: the box sits high, clear of the button.
  const view = render(<Column />)
  const box = view.getByTestId('box')
  const activity = view.getByTestId('activity')
  place(activity, 0, 100)
  place(box, 100, 300)
  resized(box)
  expect(box.dataset.lift).toBe('0')

  // Activity arrives and grows; the box moves down onto the button without changing its own size.
  place(activity, 0, 500)
  place(box, 500, 300)
  resized(activity)

  expect(Number(box.dataset.lift)).toBe(500 + 300 - 760 + 8)
  trigger.remove()
})
