import { describe, expect, it } from 'vitest'
import {
  getLegacyRemoteBrowserViewport,
  getLegacyViewportForRendering
} from './remote-browser-legacy-viewport'

describe('getLegacyRemoteBrowserViewport', () => {
  it('renders only a negotiated viewport that differs from the real pane', () => {
    expect(
      getLegacyViewportForRendering({ width: 533, height: 917 }, { width: 1097, height: 917 })
    ).toEqual({ width: 533, height: 917 })
    expect(
      getLegacyViewportForRendering({ width: 1097, height: 917 }, { width: 1097, height: 917 })
    ).toBeNull()
  })

  it('uses the complete native-width legacy surface without upscaling it', () => {
    expect(
      getLegacyRemoteBrowserViewport(
        { imageWidth: 533, imageHeight: 917, deviceWidth: 1097, deviceHeight: 917 },
        { width: 1097, height: 917 }
      )
    ).toEqual({ width: 533, height: 917 })
  })

  it('accounts for uniformly scaled image pixels before fitting', () => {
    expect(
      getLegacyRemoteBrowserViewport(
        { imageWidth: 1066, imageHeight: 1834, deviceWidth: 1097, deviceHeight: 917 },
        { width: 1097, height: 917 }
      )
    ).toEqual({ width: 533, height: 917 })
  })

  it('leaves uniformly scaled client-sized frames unchanged', () => {
    expect(
      getLegacyRemoteBrowserViewport(
        { imageWidth: 2194, imageHeight: 1834, deviceWidth: 1097, deviceHeight: 917 },
        { width: 1097, height: 917 }
      )
    ).toBeNull()
  })

  it('declines a fallback below the runtime viewport floor', () => {
    expect(
      getLegacyRemoteBrowserViewport(
        { imageWidth: 100, imageHeight: 917, deviceWidth: 1097, deviceHeight: 917 },
        { width: 1097, height: 917 }
      )
    ).toBeNull()
  })
})
