import { describe, expect, it } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import {
  clampNumber,
  createBrowserAnnotationPayload,
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

describe('browser annotation geometry', () => {
  it('clamps inclusive of both ends', () => {
    expect(clampNumber(5, 0, 10)).toBe(5)
    expect(clampNumber(-1, 0, 10)).toBe(0)
    expect(clampNumber(11, 0, 10)).toBe(10)
  })

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
