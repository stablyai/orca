import { describe, expect, it } from 'vitest'
import {
  mapRemoteBrowserClientPoint,
  resolveRemoteBrowserCssViewport
} from './remote-browser-page-input-model'

describe('remote browser page input model', () => {
  // Map input through the same contained frame box when the host cannot paint the requested pane size.
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
  })
})
