import { describe, expect, it } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import {
  applyBrowserAnnotationViewportReport,
  createBrowserAnnotationPayload,
  getBrowserOverlayAnchor,
  getLiveBrowserAnnotationRect
} from './browser-annotation-geometry'

function payload(overrides: Partial<BrowserGrabPayload['target']> = {}): BrowserGrabPayload {
  return {
    target: {
      selector: 'button',
      tagName: 'BUTTON',
      textSnippet: 'Go',
      isFixed: false,
      rectPage: { x: 100, y: 200, width: 40, height: 20 },
      rectViewport: { x: 10, y: 20, width: 40, height: 20 },
      accessibility: { accessibleName: 'Go' },
      ...overrides
    },
    nearbyText: [],
    ancestorPath: [],
    page: { url: 'https://example.com', title: 'Example', scrollX: 5, scrollY: 15 },
    screenshot: { dataUrl: 'data:image/png;base64,xx', width: 1, height: 1 }
  } as unknown as BrowserGrabPayload
}

/** Anchor for a target of the given viewport box, inside a pane of the given size. */
function anchorFor(
  rect: { x: number; y: number; width: number; height: number },
  paneWidth: number,
  paneHeight: number
): ReturnType<typeof getBrowserOverlayAnchor> {
  const pane = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: paneWidth, height: paneHeight })
  }
  return getBrowserOverlayAnchor(payload({ isFixed: true, rectViewport: rect }), pane, pane, {
    scrollX: 0,
    scrollY: 0,
    version: 0
  })
}

describe('browser annotation composer placement', () => {
  // The reported bug: a target too tall to clear vertically used to put the card on top of it.
  it('moves beside a target that leaves no vertical room', () => {
    expect(anchorFor({ x: 300, y: 150, width: 300, height: 300 }, 1400, 600)).toEqual({
      x: 600,
      y: 300,
      side: 'right'
    })
  })

  it('falls to the left band when the right one is too narrow', () => {
    expect(anchorFor({ x: 800, y: 150, width: 300, height: 300 }, 1400, 600).side).toBe('left')
  })
})

describe('browser annotation geometry', () => {
  it('uses the viewport rect for fixed targets and scroll-adjusts flowing targets', () => {
    const fixed = payload({ isFixed: true })
    expect(getLiveBrowserAnnotationRect(fixed, { scrollX: 99, scrollY: 99, version: 2 })).toEqual(
      fixed.target.rectViewport
    )

    const flowing = payload({ isFixed: false })
    expect(getLiveBrowserAnnotationRect(flowing, { scrollX: 30, scrollY: 40, version: 1 })).toEqual(
      {
        ...flowing.target.rectViewport,
        x: 70,
        y: 160
      }
    )
    expect(getLiveBrowserAnnotationRect(flowing, { scrollX: 30, scrollY: 40, version: 0 })).toEqual(
      {
        ...flowing.target.rectViewport,
        x: 95,
        y: 185
      }
    )
  })

  it('strips screenshot bytes from persisted annotation payloads', () => {
    const source = payload()
    expect(createBrowserAnnotationPayload(source).screenshot).toBeNull()
    expect(createBrowserAnnotationPayload(source).target.selector).toBe('button')
  })
})

describe('browser annotation card follows the live element', () => {
  const box = (left: number, top: number, width: number, height: number) => ({
    getBoundingClientRect: () => ({ left, top, width, height })
  })
  // Clicked at viewport (10, 20) with window scroll (5, 15).
  const clicked = payload({ isFixed: false })

  it('uses the guest-measured box over the click-time one after a box inside the page scrolls', () => {
    // Window scroll did not move, so the click-time math alone would leave the card in place.
    const viewport = applyBrowserAnnotationViewportReport(
      { scrollX: 0, scrollY: 0, version: 0 },
      { scrollX: 5, scrollY: 15, target: { x: 10, y: 300, width: 40, height: 20 } }
    )
    expect(getLiveBrowserAnnotationRect(clicked, viewport)).toEqual({
      x: 10,
      y: 300,
      width: 40,
      height: 20
    })
    const pane = box(0, 0, 900, 900)
    expect(getBrowserOverlayAnchor(clicked, pane, pane, viewport)).toEqual({
      x: 30,
      y: 320,
      side: 'bottom'
    })
  })

  it('converts guest pixels to pane pixels when the page is zoomed', () => {
    // 120% page zoom: the guest lays out 1000 CSS pixels across a 1200-pixel-wide view.
    const viewport = applyBrowserAnnotationViewportReport(
      { scrollX: 0, scrollY: 0, version: 0 },
      {
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 1000,
        target: { x: 100, y: 50, width: 50, height: 10 }
      }
    )
    const pane = box(0, 0, 1200, 900)
    expect(getBrowserOverlayAnchor(clicked, pane, pane, viewport)).toEqual({
      x: 150,
      y: 72,
      side: 'bottom'
    })
  })

  it('picks the side with the measured card height once the card has rendered', () => {
    const fixed = payload({
      isFixed: true,
      rectViewport: { x: 100, y: 40, width: 100, height: 20 }
    })
    const pane = box(0, 0, 900, 310)
    const viewport = { scrollX: 0, scrollY: 0, version: 0 }
    // 250 pixels below the target: too shallow for the assumed 240-pixel card plus margin.
    expect(getBrowserOverlayAnchor(fixed, pane, pane, viewport).side).toBe('right')
    expect(getBrowserOverlayAnchor(fixed, pane, pane, viewport, 200).side).toBe('bottom')
  })
})
