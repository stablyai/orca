// @vitest-environment happy-dom

import { act, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RightSidebarGutterResizeProvider,
  useRightSidebarGutterResize
} from './right-sidebar-gutter-resize'

const startResize = vi.fn()
let root: Root
let host: HTMLDivElement

function Scroller({ id }: { id: string }): React.JSX.Element {
  const scroll = useRef<HTMLDivElement | null>(null)
  return (
    <div data-testid={id} {...useRightSidebarGutterResize(scroll)}>
      <button type="button">row</button>
    </div>
  )
}

const ONE_SCROLLER = ['scroller']

function Sidebar({ scrollers = ONE_SCROLLER }: { scrollers?: string[] }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<HTMLDivElement | null>(null)
  const hoverOwnerRef = useRef<HTMLElement | null>(null)
  // Stable like RightSidebar's, so ref callbacks do not re-attach on every render.
  const gutter = useMemo(() => ({ startResize, containerRef, handleRef, hoverOwnerRef }), [])
  return (
    <div ref={containerRef} data-testid="container">
      <div ref={handleRef} data-testid="handle" />
      <RightSidebarGutterResizeProvider value={gutter}>
        {scrollers.map((id) => (
          <Scroller key={id} id={id} />
        ))}
      </RightSidebarGutterResizeProvider>
    </div>
  )
}

const render = (scrollers: string[]): void =>
  act(() => root.render(<Sidebar scrollers={scrollers} />))

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

  it('clears the seam tint when the hovered scroller unmounts without a mouseleave', () => {
    mouse(find('scroller'), 'mousemove', 105)
    render([])
    expect(find('handle').hasAttribute('data-gutter-hover')).toBe(false)
  })

  it('keeps a newer scroller hovered when an older one unmounts', () => {
    render(['old', 'new'])
    mouse(find('old'), 'mousemove', 105)
    mouse(find('new'), 'mousemove', 105)
    render(['new'])
    expect(find('handle').hasAttribute('data-gutter-hover')).toBe(true)
    expect(find('new').style.cursor).toBe('col-resize')
  })
})
