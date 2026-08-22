import { describe, expect, it } from 'vitest'
import { getRemoteBrowserFramePoint } from './remote-browser-frame-point'

describe('getRemoteBrowserFramePoint', () => {
  it('maps a centered native-width legacy frame and rejects its side gutters', () => {
    const input = {
      viewportRect: { left: 281, top: 87, width: 1097, height: 917 },
      naturalWidth: 533,
      naturalHeight: 917,
      metadata: { imageWidth: 533, imageHeight: 917, deviceWidth: 533, deviceHeight: 917 },
      remoteCssViewportSize: { width: 533, height: 917 },
      remoteViewportSize: { width: 1097, height: 917 },
      legacyViewportSize: { width: 533, height: 917 }
    }
    expect(
      getRemoteBrowserFramePoint({ ...input, clientX: 281 + 282 + 106, clientY: 478 })
    ).toEqual({
      x: 106,
      y: 391
    })
    expect(getRemoteBrowserFramePoint({ ...input, clientX: 281 + 100, clientY: 478 })).toBeNull()
  })

  it('maps a contained legacy frame in its actual bitmap coordinate space', () => {
    expect(
      getRemoteBrowserFramePoint({
        clientX: 281 + 106,
        clientY: 87 + 391,
        viewportRect: { left: 281, top: 87, width: 1097, height: 917 },
        naturalWidth: 533,
        naturalHeight: 917,
        metadata: {
          imageWidth: 533,
          imageHeight: 917,
          deviceWidth: 1097,
          deviceHeight: 917
        },
        remoteCssViewportSize: { width: 1097, height: 917 },
        remoteViewportSize: { width: 1097, height: 917 }
      })
    ).toEqual({ x: 106, y: 391 })
  })

  it('ignores clicks in the empty gutter beside a contained legacy frame', () => {
    expect(
      getRemoteBrowserFramePoint({
        clientX: 281 + 800,
        clientY: 87 + 391,
        viewportRect: { left: 281, top: 87, width: 1097, height: 917 },
        naturalWidth: 533,
        naturalHeight: 917,
        metadata: {
          imageWidth: 533,
          imageHeight: 917,
          deviceWidth: 1097,
          deviceHeight: 917
        },
        remoteCssViewportSize: { width: 1097, height: 917 },
        remoteViewportSize: { width: 1097, height: 917 }
      })
    ).toBeNull()
  })

  it('keeps requested viewport coordinates for uniformly scaled frames', () => {
    expect(
      getRemoteBrowserFramePoint({
        clientX: 100,
        clientY: 200,
        viewportRect: { left: 0, top: 0, width: 999, height: 609 },
        naturalWidth: 1998,
        naturalHeight: 1218,
        metadata: {
          imageWidth: 1998,
          imageHeight: 1218,
          deviceWidth: 999,
          deviceHeight: 609
        },
        remoteCssViewportSize: { width: 999, height: 609 },
        remoteViewportSize: { width: 999, height: 609 }
      })
    ).toEqual({ x: 100, y: 200 })
  })
})
