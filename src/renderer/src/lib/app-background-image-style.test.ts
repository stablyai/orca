import { describe, expect, it } from 'vitest'
import { resolveAppBackgroundImageStyle } from './app-background-image-style'
import {
  DEFAULT_APP_BACKGROUND_IMAGE_OPACITY,
  MAX_APP_BACKGROUND_IMAGE_OPACITY
} from '../../../shared/app-background-image'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

describe('resolveAppBackgroundImageStyle', () => {
  it('returns undefined without a configured image', () => {
    expect(resolveAppBackgroundImageStyle(undefined)).toBeUndefined()
    expect(resolveAppBackgroundImageStyle({})).toBeUndefined()
    expect(resolveAppBackgroundImageStyle({ appBackgroundImage: 'not-a-data-url' })).toBeUndefined()
  })

  it('builds a style from the image with defaults applied', () => {
    expect(resolveAppBackgroundImageStyle({ appBackgroundImage: PNG_DATA_URL })).toEqual({
      backgroundImage: `url("${PNG_DATA_URL}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      opacity: DEFAULT_APP_BACKGROUND_IMAGE_OPACITY
    })
  })

  it('maps each fit to its background-size', () => {
    const sizeFor = (
      fit: 'cover' | 'contain' | 'stretch' | 'center'
    ): string | number | undefined =>
      resolveAppBackgroundImageStyle({
        appBackgroundImage: PNG_DATA_URL,
        appBackgroundImageFit: fit
      })?.backgroundSize
    expect(sizeFor('cover')).toBe('cover')
    expect(sizeFor('contain')).toBe('contain')
    expect(sizeFor('stretch')).toBe('100% 100%')
    expect(sizeFor('center')).toBe('auto')
  })

  it('clamps opacity so the UI stays readable', () => {
    expect(
      resolveAppBackgroundImageStyle({
        appBackgroundImage: PNG_DATA_URL,
        appBackgroundImageOpacity: 5
      })?.opacity
    ).toBe(MAX_APP_BACKGROUND_IMAGE_OPACITY)
  })
})
