// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RightSidebarGutterResizeProvider,
  useRightSidebarGutterResize
} from './right-sidebar-gutter-resize'

const startResize = vi.fn()
let root: Root
let host: HTMLDivElement

function Scroller(): React.JSX.Element {
  return (
    <div data-testid="scroller" {...useRightSidebarGutterResize()}>
      <button type="button">row</button>
    </div>
  )
}

function Sidebar(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={containerRef} data-testid="container">
      <div ref={handleRef} data-testid="handle" />
      <RightSidebarGutterResizeProvider value={{ startResize, containerRef, handleRef }}>
        <Scroller />
      </RightSidebarGutterResizeProvider>
    </div>
  )
}

const find = (id: string): HTMLElement => host.querySelector(`[data-testid="${id}"]`)!

function mouse(target: Element, type: string, clientX: number, init: MouseEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, ...init }))
  })
}

beforeEach(() => {
  startResize.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Sidebar />))
  // The seam's outer edge sits at x=100.
  find('container').getBoundingClientRect = () => new DOMRect(100, 0, 220, 300)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('right sidebar gutter resize', () => {
  it('starts the resize only from the scroller padding within 10 px of the seam', () => {
    mouse(find('scroller'), 'mousedown', 109.5)
    expect(startResize).toHaveBeenCalledTimes(1)
    mouse(find('scroller'), 'mousedown', 110)
    expect(startResize).toHaveBeenCalledTimes(1)
  })

  it('leaves content and non-primary buttons alone', () => {
    mouse(find('scroller').querySelector('button')!, 'mousedown', 105)
    mouse(find('scroller'), 'mousedown', 105, { button: 2 })
    expect(startResize).not.toHaveBeenCalled()
  })

  it('shows the resize affordance only while hovering the strip', () => {
    mouse(find('scroller'), 'mousemove', 105)
    expect(find('scroller').style.cursor).toBe('col-resize')
    expect(find('handle').hasAttribute('data-gutter-hover')).toBe(true)
    mouse(find('scroller'), 'mousemove', 112)
    expect(find('scroller').style.cursor).toBe('')
    expect(find('handle').hasAttribute('data-gutter-hover')).toBe(false)
  })
})
