// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useScrollEdgeFades } from './use-scroll-edge-fades'

let root: Root
let container: HTMLDivElement
let scrollHeight: number
const resizeTargets = new Set<Element>()
let onResize = (): void => {}

function Probe() {
  const fades = useScrollEdgeFades<HTMLDivElement>()
  return (
    <div ref={fades.ref} className={fades.className} data-scroller>
      <div style={{ height: '100%' }}>
        <div data-content />
      </div>
    </div>
  )
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  scrollHeight = 100
  resizeTargets.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        onResize = callback
      }
      observe(target: Element) {
        resizeTargets.add(target)
      }
      unobserve(target: Element) {
        resizeTargets.delete(target)
      }
      disconnect() {
        resizeTargets.clear()
      }
    }
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Probe />))
  const scroller = container.querySelector('[data-scroller]')
  if (!scroller) {
    throw new Error('Missing scroller')
  }
  Object.defineProperties(scroller, {
    clientHeight: { get: () => 100 },
    scrollHeight: { get: () => scrollHeight }
  })
})

afterEach(() => {
  act(() => root.unmount())
  expect(resizeTargets.size).toBe(0)
  container.remove()
  vi.unstubAllGlobals()
})

it('updates fades for nested insertion, resizing, and removal without scrolling', async () => {
  const scroller = container.querySelector('[data-scroller]')
  const content = container.querySelector('[data-content]')
  if (!scroller || !content) {
    throw new Error('Missing scroll content')
  }
  const disclosure = document.createElement('div')
  scrollHeight = 200
  await act(async () => content.appendChild(disclosure))
  expect(scroller.className).toContain('mask-b-')

  scrollHeight = 100
  act(() => {
    if (resizeTargets.has(disclosure)) {
      onResize()
    }
  })
  expect(scroller.className).not.toContain('mask-b-')

  scrollHeight = 200
  act(() => {
    if (resizeTargets.has(disclosure)) {
      onResize()
    }
  })
  expect(scroller.className).toContain('mask-b-')

  scrollHeight = 100
  await act(async () => disclosure.remove())
  expect(scroller.className).not.toContain('mask-b-')
  expect(resizeTargets.has(disclosure)).toBe(false)
})
