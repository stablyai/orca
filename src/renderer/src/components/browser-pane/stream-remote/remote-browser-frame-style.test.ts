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
})
