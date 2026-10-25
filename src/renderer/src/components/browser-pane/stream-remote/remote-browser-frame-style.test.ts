import { describe, expect, it } from 'vitest'
import { getRemoteBrowserFrameStyle } from './remote-browser-frame-style'

describe('getRemoteBrowserFrameStyle', () => {
  it('fits the frame by the CSS viewport it shows, not by the bitmap size', () => {
    expect(
      getRemoteBrowserFrameStyle({
        imageWidth: 2266,
        imageHeight: 1309,
        deviceWidth: 958,
        deviceHeight: 609
      })
    ).toEqual({
      inset: 0,
      margin: 'auto',
      width: `min(100cqw, calc(100cqh * ${958 / 609}))`,
      height: `min(100cqh, calc(100cqw / ${958 / 609}))`,
      objectFit: 'fill'
    })
  })

  it('fills the pane when the frame does not say what it shows', () => {
    expect(getRemoteBrowserFrameStyle({ imageWidth: 800, imageHeight: 600 })).toEqual({
      width: '100%',
      height: '100%',
      objectFit: 'fill',
      objectPosition: 'top left'
    })
  })
})
