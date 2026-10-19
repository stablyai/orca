import { describe, expect, it } from 'vitest'
import {
  buildRemoteContextMenuExpression,
  getPositiveFiniteNumber,
  getRemoteBrowserMouseButton,
  mapRemoteBrowserClientPoint,
  readRemoteContextMenuResult,
  readRemoteCssViewportSize,
  resolveRemoteBrowserCssViewport
} from './remote-browser-page-input-model'

describe('remote browser page input model', () => {
  it('maps mouse buttons and rejects unknown codes', () => {
    expect(getRemoteBrowserMouseButton(0)).toBe('left')
    expect(getRemoteBrowserMouseButton(1)).toBe('middle')
    expect(getRemoteBrowserMouseButton(2)).toBe('right')
    expect(getRemoteBrowserMouseButton(3)).toBeNull()
  })

  it('accepts only positive finite numbers', () => {
    expect(getPositiveFiniteNumber(12)).toBe(12)
    expect(getPositiveFiniteNumber(0)).toBeNull()
    expect(getPositiveFiniteNumber(-1)).toBeNull()
    expect(getPositiveFiniteNumber(Number.NaN)).toBeNull()
    expect(getPositiveFiniteNumber('12')).toBeNull()
  })

  it('embeds coordinates in the guest context-menu expression', () => {
    const expression = buildRemoteContextMenuExpression(10, 20)
    expect(expression).toContain('10')
    expect(expression).toContain('20')
    expect(expression).toContain('elementFromPoint')
  })

  it('parses context-menu eval results and rejects junk', () => {
    expect(readRemoteContextMenuResult(null)).toBeNull()
    expect(readRemoteContextMenuResult({ result: 1 })).toBeNull()
    expect(
      readRemoteContextMenuResult({
        result: JSON.stringify({
          linkUrl: 'https://example.com',
          pageUrl: 'https://example.com/page',
          selectionText: 'hi'
        })
      })
    ).toEqual({
      linkUrl: 'https://example.com',
      pageUrl: 'https://example.com/page',
      selectionText: 'hi'
    })
    expect(readRemoteContextMenuResult({ result: JSON.stringify({ linkUrl: '' }) })).toEqual({
      linkUrl: null,
      pageUrl: 'about:blank',
      selectionText: ''
    })
  })

  it('parses CSS viewport sizes from eval results', () => {
    expect(
      readRemoteCssViewportSize({ result: JSON.stringify({ width: 800, height: 600 }) })
    ).toEqual({ width: 800, height: 600 })
    expect(
      readRemoteCssViewportSize({ result: JSON.stringify({ width: 0, height: 600 }) })
    ).toBeNull()
    expect(readRemoteCssViewportSize({ result: 'not-json' })).toBeNull()
  })

  describe('resolveRemoteBrowserCssViewport', () => {
    const naturalSize = { width: 2800, height: 1800 }

    it('keeps the cached CSS viewport while frames report the size this pane requested', () => {
      expect(
        resolveRemoteBrowserCssViewport({
          // Scrollbars make the page's own innerWidth differ from the requested size, which
          // is the whole reason the cache is preferred over the frame metadata.
          cssViewportSize: { width: 1385, height: 900 },
          requestedViewportSize: { width: 1400, height: 900 },
          frameMetadata: { deviceWidth: 1400, deviceHeight: 900 },
          naturalSize
        })
      ).toEqual({ width: 1385, height: 900 })
    })

    it('falls back to the frame device size once another subscriber owns the viewport', () => {
      expect(
        resolveRemoteBrowserCssViewport({
          cssViewportSize: { width: 1385, height: 900 },
          requestedViewportSize: { width: 1400, height: 900 },
          frameMetadata: { deviceWidth: 390, deviceHeight: 844 },
          naturalSize
        })
      ).toEqual({ width: 390, height: 844 })
    })

    it('keeps the cache when frames carry no device size and falls back to natural size', () => {
      expect(
        resolveRemoteBrowserCssViewport({
          cssViewportSize: { width: 1385, height: 900 },
          requestedViewportSize: { width: 1400, height: 900 },
          frameMetadata: null,
          naturalSize
        })
      ).toEqual({ width: 1385, height: 900 })
      expect(
        resolveRemoteBrowserCssViewport({
          cssViewportSize: null,
          requestedViewportSize: null,
          frameMetadata: null,
          naturalSize
        })
      ).toEqual(naturalSize)
    })
  })

  // #30341: the host can only paint 1463x849 of the 1833x1179 this pane asked for, so the frame
  // is letterboxed (contain) inside the pane and input must go through that same box.
  describe('pointer mapping for a frame smaller than the pane', () => {
    const pane = { left: 0, top: 0, width: 1833, height: 1179 }
    const frame = { width: 1463, height: 849 }
    const scale = Math.min(pane.width / frame.width, pane.height / frame.height)
    const frameRect = {
      width: frame.width * scale,
      height: frame.height * scale,
      left: (pane.width - frame.width * scale) / 2,
      top: (pane.height - frame.height * scale) / 2
    }
    const cssViewport = resolveRemoteBrowserCssViewport({
      cssViewportSize: { width: 1833, height: 1179 },
      requestedViewportSize: { width: 1833, height: 1179 },
      frameMetadata: { deviceWidth: frame.width, deviceHeight: frame.height },
      naturalSize: { width: 2926, height: 1698 }
    })
    const screenOf = (x: number, y: number) => ({
      clientX: frameRect.left + x * scale,
      clientY: frameRect.top + y * scale
    })

    it('lands on the page point drawn under the pointer, corners included', () => {
      expect(cssViewport).toEqual(frame)
      for (const [x, y] of [
        [0, 0],
        [731, 424],
        [1463, 849],
        [1200, 100]
      ]) {
        expect(mapRemoteBrowserClientPoint({ ...screenOf(x, y), frameRect, cssViewport })).toEqual({
          x,
          y
        })
      }
    })

    it('clamps a pointer in the letterbox to the page edge', () => {
      expect(
        mapRemoteBrowserClientPoint({ clientX: 10, clientY: 2, frameRect, cssViewport })
      ).toEqual({ x: 8, y: 0 })
    })

    it('refuses a frame that has no box yet', () => {
      expect(
        mapRemoteBrowserClientPoint({
          clientX: 1,
          clientY: 1,
          frameRect: { left: 0, top: 0, width: 0, height: 0 },
          cssViewport
        })
      ).toBeNull()
    })
  })
})
