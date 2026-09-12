// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MermaidZoomSurface from './MermaidZoomSurface'
import { MAX_SURFACE_ZOOM, MIN_SURFACE_ZOOM } from './surface-zoom'

const DIAGRAM_WIDTH = 800
const DIAGRAM_HEIGHT = 600
const SURFACE_WIDTH = 400
const SURFACE_HEIGHT = 400

// Why: the error path reports a null size, which must leave the box unmeasured.
const renderedSize: { current: { width: number; height: number } | null } = {
  current: { width: DIAGRAM_WIDTH, height: DIAGRAM_HEIGHT }
}

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Why: the real block loads ~650KB of mermaid and renders asynchronously; the
// surface only depends on the intrinsic size it reports back.
vi.mock('./MermaidBlock', async () => {
  const { createElement, useEffect } = await import('react')
  function MermaidBlockStub({
    onRendered
  }: {
    onRendered?: (size: { width: number; height: number } | null) => void
  }) {
    useEffect(() => {
      onRendered?.(renderedSize.current)
    }, [onRendered])
    return createElement('div', { className: 'mermaid-block', 'data-testid': 'mermaid-block' })
  }
  return { default: MermaidBlockStub }
})

// Why: happy-dom reports every element as 0x0, so the surface would never get a
// measurable size to fit the diagram into.
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

beforeEach(() => {
  renderedSize.current = { width: DIAGRAM_WIDTH, height: DIAGRAM_HEIGHT }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => SURFACE_WIDTH
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => SURFACE_HEIGHT
  })
})

afterEach(() => {
  cleanup()
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  }
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
  }
})

function renderSurface(): HTMLElement {
  const { container } = render(<MermaidZoomSurface content="graph TD; a-->b" isDark={false} />)
  const surface = container.querySelector('.mermaid-viewer')
  if (!(surface instanceof HTMLElement)) {
    throw new Error('zoom surface not rendered')
  }
  return surface
}

function getDiagramBox(): HTMLElement {
  const box = document.querySelector('.mermaid-diagram-box')
  if (!(box instanceof HTMLElement)) {
    throw new Error('diagram box not rendered')
  }
  return box
}

function getZoomPercent(): number {
  const label = document.querySelector('.tabular-nums')?.textContent ?? ''
  return Number.parseInt(label, 10)
}

function setScrollExtents(surface: HTMLElement, { horizontal }: { horizontal: boolean }): void {
  // Why: happy-dom does not lay out, so a zoomed surface reports no overflow
  // and the pan handler would refuse to start.
  Object.defineProperty(surface, 'scrollWidth', {
    configurable: true,
    get: () => (horizontal ? SURFACE_WIDTH * 3 : SURFACE_WIDTH)
  })
  Object.defineProperty(surface, 'scrollHeight', {
    configurable: true,
    get: () => (horizontal ? SURFACE_HEIGHT : SURFACE_HEIGHT * 3)
  })
}

function stubPointerCapture(surface: HTMLElement): {
  setPointerCapture: ReturnType<typeof vi.fn>
  releasePointerCapture: ReturnType<typeof vi.fn>
} {
  const setPointerCapture = vi.fn()
  const releasePointerCapture = vi.fn()
  Object.assign(surface, { setPointerCapture, releasePointerCapture })
  return { setPointerCapture, releasePointerCapture }
}

function dispatchPointer(
  surface: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  {
    clientX,
    clientY,
    pointerId = 1,
    button = 0,
    pointerType = 'mouse'
  }: {
    clientX: number
    clientY: number
    pointerId?: number
    button?: number
    pointerType?: string
  }
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX, clientY, pointerId, button, pointerType })
  fireEvent(surface, event)
}

function dispatchWheel(
  surface: HTMLElement,
  { deltaY, ctrlKey = false }: { deltaY: number; ctrlKey?: boolean }
): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY })
  // Why: happy-dom's WheelEvent leaves ctrlKey undefined, and ctrl-wheel is how
  // Chromium reports a trackpad pinch.
  Object.defineProperty(event, 'ctrlKey', { value: ctrlKey })
  fireEvent(surface, event)
  return event
}

describe('MermaidZoomSurface', () => {
  it('sizes the diagram box in pixels once the diagram reports its size', () => {
    renderSurface()

    const box = getDiagramBox()
    expect(box.dataset.zoomLayout).toBe('true')
    // The 800x600 diagram is fitted into the 400x400 surface minus the 24px
    // canvas padding on each side, keeping its aspect ratio.
    expect(box.style.width).toBe('352px')
    expect(box.style.height).toBe('264px')
    expect(getZoomPercent()).toBe(100)
  })

  it('grows the layout box when zooming in so scroll extents can reach the diagram', () => {
    renderSurface()
    const widthBefore = Number.parseFloat(getDiagramBox().style.width)

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    expect(Number.parseFloat(getDiagramBox().style.width)).toBeGreaterThan(widthBefore)
    expect(getZoomPercent()).toBe(125)
  })

  it('returns to a fitted diagram when resetting zoom', () => {
    renderSurface()
    const fittedWidth = getDiagramBox().style.width

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(getDiagramBox().style.width).not.toBe(fittedWidth)

    fireEvent.click(screen.getByRole('button', { name: 'Fit diagram' }))
    expect(getDiagramBox().style.width).toBe(fittedWidth)
    expect(getZoomPercent()).toBe(100)
  })

  it('zooms on ctrl-wheel and leaves plain wheel to scroll the surface', () => {
    const surface = renderSurface()

    const plainWheel = dispatchWheel(surface, { deltaY: -120 })
    expect(plainWheel.defaultPrevented).toBe(false)
    expect(getZoomPercent()).toBe(100)

    const zoomWheel = dispatchWheel(surface, { deltaY: -120, ctrlKey: true })
    expect(zoomWheel.defaultPrevented).toBe(true)
    expect(getZoomPercent()).toBeGreaterThan(100)
  })

  it('disables each control at its zoom bound', () => {
    const surface = renderSurface()
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement
    const fit = screen.getByRole('button', { name: 'Fit diagram' }) as HTMLButtonElement

    expect(fit.disabled).toBe(true)

    // Why: a single event is deliberately capped, so reaching a bound takes
    // several gestures rather than one huge delta.
    for (let index = 0; index < 10; index += 1) {
      dispatchWheel(surface, { deltaY: -1000, ctrlKey: true })
    }
    expect(getZoomPercent()).toBe(MAX_SURFACE_ZOOM * 100)
    expect(zoomIn.disabled).toBe(true)

    for (let index = 0; index < 10; index += 1) {
      dispatchWheel(surface, { deltaY: 1000, ctrlKey: true })
    }
    expect(getZoomPercent()).toBe(MIN_SURFACE_ZOOM * 100)
    expect(zoomOut.disabled).toBe(true)
  })

  it('pans the surface by dragging inside the diagram', () => {
    const surface = renderSurface()
    setScrollExtents(surface, { horizontal: true })
    const { setPointerCapture, releasePointerCapture } = stubPointerCapture(surface)
    surface.scrollLeft = 120
    surface.scrollTop = 40

    dispatchPointer(surface, 'pointerdown', { clientX: 300, clientY: 200 })
    expect(setPointerCapture).toHaveBeenCalledWith(1)

    dispatchPointer(surface, 'pointermove', { clientX: 260, clientY: 175 })
    expect(surface.scrollLeft).toBe(160)
    expect(surface.scrollTop).toBe(65)

    // Each move is measured from the press, not from the previous move.
    dispatchPointer(surface, 'pointermove', { clientX: 250, clientY: 170 })
    expect(surface.scrollLeft).toBe(170)
    expect(surface.scrollTop).toBe(70)

    dispatchPointer(surface, 'pointerup', { clientX: 250, clientY: 170 })
    expect(releasePointerCapture).toHaveBeenCalledWith(1)

    dispatchPointer(surface, 'pointermove', { clientX: 100, clientY: 100 })
    expect(surface.scrollLeft).toBe(170)
  })

  it('does not start a pan when the diagram already fits', () => {
    const surface = renderSurface()
    setScrollExtents(surface, { horizontal: false })
    Object.defineProperty(surface, 'scrollHeight', {
      configurable: true,
      get: () => SURFACE_HEIGHT
    })
    const { setPointerCapture } = stubPointerCapture(surface)
    surface.scrollLeft = 0

    dispatchPointer(surface, 'pointerdown', { clientX: 300, clientY: 200 })
    dispatchPointer(surface, 'pointermove', { clientX: 200, clientY: 200 })

    expect(setPointerCapture).not.toHaveBeenCalled()
    expect(surface.scrollLeft).toBe(0)
  })

  it('leaves touch drags to native scrolling', () => {
    const surface = renderSurface()
    setScrollExtents(surface, { horizontal: true })
    const { setPointerCapture } = stubPointerCapture(surface)
    surface.scrollLeft = 50

    dispatchPointer(surface, 'pointerdown', { clientX: 300, clientY: 200, pointerType: 'touch' })
    dispatchPointer(surface, 'pointermove', { clientX: 200, clientY: 200, pointerType: 'touch' })

    expect(setPointerCapture).not.toHaveBeenCalled()
    expect(surface.scrollLeft).toBe(50)
  })

  it('stops panning when the pointer capture is lost', () => {
    const surface = renderSurface()
    setScrollExtents(surface, { horizontal: true })
    stubPointerCapture(surface)
    surface.scrollLeft = 0

    dispatchPointer(surface, 'pointerdown', { clientX: 300, clientY: 200 })
    dispatchPointer(surface, 'pointercancel', { clientX: 300, clientY: 200 })
    dispatchPointer(surface, 'pointermove', { clientX: 100, clientY: 200 })

    expect(surface.scrollLeft).toBe(0)
  })

  it('advertises a grab cursor only once the diagram can be panned', () => {
    const surface = renderSurface()
    expect(surface.className).not.toContain('cursor-grab')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    const zoomedSurface = document.querySelector('.mermaid-viewer')
    expect(zoomedSurface?.className).toContain('cursor-grab')
  })

  it('leaves the box unmeasured and hides the controls when the diagram fails to render', () => {
    renderedSize.current = null
    renderSurface()

    const box = getDiagramBox()
    expect(box.dataset.zoomLayout).toBe('false')
    expect(box.style.width).toBe('')
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
  })

  it('detaches the wheel listener when the surface unmounts', () => {
    const { container, unmount } = render(
      <MermaidZoomSurface content="graph TD; a-->b" isDark={false} />
    )
    const surface = container.querySelector('.mermaid-viewer')
    if (!(surface instanceof HTMLElement)) {
      throw new Error('zoom surface not rendered')
    }
    const removeEventListener = vi.spyOn(surface, 'removeEventListener')

    unmount()

    expect(removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function))
  })
})
