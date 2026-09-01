import { describe, expect, it } from 'vitest'
import {
  sanitizeAppBackgroundImageSettingsUpdate,
  DEFAULT_APP_BACKGROUND_IMAGE_FIT,
  DEFAULT_APP_BACKGROUND_IMAGE_OPACITY,
  MAX_APP_BACKGROUND_IMAGE_OPACITY,
  normalizeAppBackgroundImage,
  normalizeAppBackgroundImageFit,
  normalizeAppBackgroundImageOpacity
} from './app-background-image'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

describe('normalizeAppBackgroundImage', () => {
  it('accepts an inline image data URL', () => {
    expect(normalizeAppBackgroundImage(PNG_DATA_URL)).toBe(PNG_DATA_URL)
    expect(normalizeAppBackgroundImage('data:image/jpeg;base64,/9j/4AAQ')).toBe(
      'data:image/jpeg;base64,/9j/4AAQ'
    )
  })

  it('rejects non-strings and empty values', () => {
    expect(normalizeAppBackgroundImage(undefined)).toBeUndefined()
    expect(normalizeAppBackgroundImage(null)).toBeUndefined()
    expect(normalizeAppBackgroundImage(42)).toBeUndefined()
    expect(normalizeAppBackgroundImage('')).toBeUndefined()
  })

  it('rejects non-image and non-data URLs', () => {
    expect(normalizeAppBackgroundImage('https://example.com/bg.png')).toBeUndefined()
    expect(normalizeAppBackgroundImage('data:text/html;base64,PGI+')).toBeUndefined()
    expect(normalizeAppBackgroundImage('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined()
    expect(normalizeAppBackgroundImage('file:///tmp/bg.png')).toBeUndefined()
  })

  it('rejects data URLs with non-base64 payload characters', () => {
    expect(normalizeAppBackgroundImage('data:image/png;base64,abc"onerror="x')).toBeUndefined()
  })

  it('rejects a payload over the size cap', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}`
    expect(normalizeAppBackgroundImage(oversized)).toBeUndefined()
  })
})

describe('normalizeAppBackgroundImageOpacity', () => {
  it('clamps into the visible-but-readable range', () => {
    expect(normalizeAppBackgroundImageOpacity(-1)).toBe(0)
    expect(normalizeAppBackgroundImageOpacity(0.2)).toBe(0.2)
    expect(normalizeAppBackgroundImageOpacity(1)).toBe(MAX_APP_BACKGROUND_IMAGE_OPACITY)
  })

  it('falls back to the default for non-numbers', () => {
    expect(normalizeAppBackgroundImageOpacity(undefined)).toBe(DEFAULT_APP_BACKGROUND_IMAGE_OPACITY)
    expect(normalizeAppBackgroundImageOpacity(Number.NaN)).toBe(
      DEFAULT_APP_BACKGROUND_IMAGE_OPACITY
    )
    expect(normalizeAppBackgroundImageOpacity('0.5')).toBe(DEFAULT_APP_BACKGROUND_IMAGE_OPACITY)
  })
})

describe('normalizeAppBackgroundImageFit', () => {
  it('keeps known fits and defaults the rest', () => {
    expect(normalizeAppBackgroundImageFit('contain')).toBe('contain')
    expect(normalizeAppBackgroundImageFit('stretch')).toBe('stretch')
    expect(normalizeAppBackgroundImageFit('tile')).toBe(DEFAULT_APP_BACKGROUND_IMAGE_FIT)
    expect(normalizeAppBackgroundImageFit(undefined)).toBe(DEFAULT_APP_BACKGROUND_IMAGE_FIT)
  })
})

describe('sanitizeAppBackgroundImageSettingsUpdate', () => {
  it('leaves absent keys absent so unrelated updates stay untouched', () => {
    expect(sanitizeAppBackgroundImageSettingsUpdate({})).toEqual({})
  })

  it('normalizes each present key', () => {
    expect(
      sanitizeAppBackgroundImageSettingsUpdate({
        appBackgroundImage: 'javascript:alert(1)',
        appBackgroundImageOpacity: 9,
        appBackgroundImageFit: 'tile'
      })
    ).toEqual({
      appBackgroundImage: undefined,
      appBackgroundImageOpacity: MAX_APP_BACKGROUND_IMAGE_OPACITY,
      appBackgroundImageFit: DEFAULT_APP_BACKGROUND_IMAGE_FIT
    })
  })

  it('keeps a valid update intact', () => {
    expect(
      sanitizeAppBackgroundImageSettingsUpdate({
        appBackgroundImage: PNG_DATA_URL,
        appBackgroundImageOpacity: 0.12,
        appBackgroundImageFit: 'contain'
      })
    ).toEqual({
      appBackgroundImage: PNG_DATA_URL,
      appBackgroundImageOpacity: 0.12,
      appBackgroundImageFit: 'contain'
    })
  })
})
