import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from './global-settings-types'
import {
  DEFAULT_APP_BACKGROUND_BLUR_PX,
  DEFAULT_APP_BACKGROUND_IMAGE_OPACITY,
  DEFAULT_APP_BACKGROUND_PANEL_OPACITY,
  getAppBackgroundImageMimeType,
  isAppBackgroundImageId,
  normalizeAppBackgroundBlur,
  normalizeAppBackgroundImageId,
  normalizeAppBackgroundImageOpacity,
  normalizeAppBackgroundPanelOpacity,
  normalizeAppBackgroundScope,
  normalizeAppBackgroundSettingsUpdate
} from './app-background-settings'

const UUID = '0b75a9ce-1471-4d83-950b-815f4d4d47cc'

describe('app background defaults', () => {
  it('shows the image at full strength and lets the panels do the masking', () => {
    // Why: a second fade on the image doubles the wash-out on light themes.
    expect(DEFAULT_APP_BACKGROUND_IMAGE_OPACITY).toBe(1)
    expect(DEFAULT_APP_BACKGROUND_BLUR_PX).toBe(4)
    expect(DEFAULT_APP_BACKGROUND_PANEL_OPACITY).toBe(0.8)
  })
})

describe('app background settings normalization', () => {
  it('clamps image opacity to 0..1 and falls back on non-finite input', () => {
    expect(normalizeAppBackgroundImageOpacity(0)).toBe(0)
    expect(normalizeAppBackgroundImageOpacity(1)).toBe(1)
    expect(normalizeAppBackgroundImageOpacity(-0.5)).toBe(0)
    expect(normalizeAppBackgroundImageOpacity(1.5)).toBe(1)
    expect(normalizeAppBackgroundImageOpacity(Number.NaN)).toBe(
      DEFAULT_APP_BACKGROUND_IMAGE_OPACITY
    )
    expect(normalizeAppBackgroundImageOpacity('0.3')).toBe(DEFAULT_APP_BACKGROUND_IMAGE_OPACITY)
  })

  it('clamps blur to 0..20 px', () => {
    expect(normalizeAppBackgroundBlur(20)).toBe(20)
    expect(normalizeAppBackgroundBlur(21)).toBe(20)
    expect(normalizeAppBackgroundBlur(-1)).toBe(0)
    expect(normalizeAppBackgroundBlur(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_APP_BACKGROUND_BLUR_PX
    )
    expect(normalizeAppBackgroundBlur(undefined)).toBe(DEFAULT_APP_BACKGROUND_BLUR_PX)
  })

  it('clamps panel opacity to 0.2..1', () => {
    expect(normalizeAppBackgroundPanelOpacity(0.2)).toBe(0.2)
    expect(normalizeAppBackgroundPanelOpacity(0.1)).toBe(0.2)
    expect(normalizeAppBackgroundPanelOpacity(2)).toBe(1)
    expect(normalizeAppBackgroundPanelOpacity(null)).toBe(DEFAULT_APP_BACKGROUND_PANEL_OPACITY)
  })

  it('accepts only known scopes', () => {
    expect(normalizeAppBackgroundScope('workspace')).toBe('workspace')
    expect(normalizeAppBackgroundScope('window')).toBe('window')
    expect(normalizeAppBackgroundScope('editor')).toBe('window')
    expect(normalizeAppBackgroundScope(undefined)).toBe('window')
  })

  it('accepts only main-generated uuid image ids', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      expect(isAppBackgroundImageId(`${UUID}.${ext}`)).toBe(true)
    }
    expect(isAppBackgroundImageId(`${UUID}.svg`)).toBe(false)
    expect(isAppBackgroundImageId(`${UUID.toUpperCase()}.png`)).toBe(false)
    expect(isAppBackgroundImageId(`../${UUID}.png`)).toBe(false)
    expect(isAppBackgroundImageId(`${UUID}.png/../../x.png`)).toBe(false)
    expect(isAppBackgroundImageId(UUID)).toBe(false)
    expect(normalizeAppBackgroundImageId(42)).toBeNull()
    expect(normalizeAppBackgroundImageId(`${UUID}.webp`)).toBe(`${UUID}.webp`)
  })

  it('normalizes only the background keys present in an update', () => {
    const update: Partial<GlobalSettings> = {
      appBackgroundImageOpacity: 3,
      appBackgroundPanelOpacity: 0
    }
    normalizeAppBackgroundSettingsUpdate(update)
    expect(update).toEqual({ appBackgroundImageOpacity: 1, appBackgroundPanelOpacity: 0.2 })
  })

  it('maps allowed extensions to MIME types and rejects the rest', () => {
    expect(getAppBackgroundImageMimeType(`${UUID}.JPG`)).toBe('image/jpeg')
    expect(getAppBackgroundImageMimeType('.webp')).toBe('image/webp')
    expect(getAppBackgroundImageMimeType('gif')).toBe('image/gif')
    expect(getAppBackgroundImageMimeType('a.svg')).toBeNull()
    expect(getAppBackgroundImageMimeType('a.constructor')).toBeNull()
  })
})
