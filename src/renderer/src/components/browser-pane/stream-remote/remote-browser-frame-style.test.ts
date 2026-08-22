import { describe, expect, it } from 'vitest'
import { getRemoteBrowserFrameStyle } from './remote-browser-frame-style'

describe('getRemoteBrowserFrameStyle', () => {
  it('centers a recovered legacy viewport without upscaling its pixels', () => {
    expect(
      getRemoteBrowserFrameStyle(
        { imageWidth: 533, imageHeight: 917, deviceWidth: 533, deviceHeight: 917 },
        { width: 533, height: 917 }
      )
    ).toEqual({
      width: '533px',
      height: '917px',
      left: '50%',
      transform: 'translateX(-50%)',
      objectFit: 'fill',
      objectPosition: 'top left'
    })
  })

  it('contains a host-sized legacy frame without distorting it', () => {
    expect(
      getRemoteBrowserFrameStyle({
        imageWidth: 533,
        imageHeight: 917,
        deviceWidth: 1097,
        deviceHeight: 917
      })
    ).toEqual({
      width: '100%',
      height: '100%',
      objectFit: 'contain',
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

  it('contains malformed non-uniform frame metadata', () => {
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
      objectFit: 'contain',
      objectPosition: 'top left'
    })
  })
})
