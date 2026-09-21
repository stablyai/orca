import { describe, expect, it } from 'vitest'
import { getRemoteBrowserFrameStyle } from './remote-browser-frame-style'

describe('getRemoteBrowserFrameStyle', () => {
  it('fills the client viewport even when stale metadata reports an oversized bitmap', () => {
    expect(
      getRemoteBrowserFrameStyle({
        imageWidth: 2266,
        imageHeight: 1309,
        deviceWidth: 958,
        deviceHeight: 609
      })
    ).toEqual({
      width: '100%',
      height: '100%',
      objectFit: 'fill',
      objectPosition: 'top left'
    })
  })

  it('keeps correctly sized frames filling the viewport', () => {
    expect(
      getRemoteBrowserFrameStyle({
        imageWidth: 958,
        imageHeight: 609,
        deviceWidth: 958,
        deviceHeight: 609
      })
    ).toEqual({
      width: '100%',
      height: '100%',
      objectFit: 'fill',
      objectPosition: 'top left'
    })
  })

  it('does not crop high-DPI frames with a uniform device scale', () => {
    expect(
      getRemoteBrowserFrameStyle({
        imageWidth: 1998,
        imageHeight: 1218,
        deviceWidth: 999,
        deviceHeight: 609
      })
    ).toEqual({
      width: '100%',
      height: '100%',
      objectFit: 'fill',
      objectPosition: 'top left'
    })
  })

  it('does not crop slightly uneven high-DPI frames after navigation', () => {
    expect(
      getRemoteBrowserFrameStyle({
        imageWidth: 3278,
        imageHeight: 2070,
        deviceWidth: 999,
        deviceHeight: 609
      })
    ).toEqual({
      width: '100%',
      height: '100%',
      objectFit: 'fill',
      objectPosition: 'top left'
    })
  })

  it('does not shrink malformed frame metadata below the viewport', () => {
    expect(
      getRemoteBrowserFrameStyle({
        imageWidth: 10,
        imageHeight: 10,
        deviceWidth: 958,
        deviceHeight: 609
      })
    ).toEqual({
      width: '100%',
      height: '100%',
      objectFit: 'fill',
      objectPosition: 'top left'
    })
  })
})
