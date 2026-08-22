import { describe, expect, it } from 'vitest'
import {
  MAX_TERMINAL_BACKGROUND_IMAGE_DATA_URL_LENGTH,
  normalizeTerminalBackgroundImage,
  normalizeTerminalBackgroundImageFit,
  normalizeTerminalBackgroundImageOpacity,
  resolveTerminalBackgroundImageCss,
  sanitizeTerminalBackgroundImageSettings,
  type TerminalBackgroundImageSettings
} from './terminal-background-image'

// 1x1 transparent PNG.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('normalizeTerminalBackgroundImage', () => {
  it('keeps a valid base64 image data URL', () => {
    expect(normalizeTerminalBackgroundImage(PNG_DATA_URL)).toBe(PNG_DATA_URL)
    expect(normalizeTerminalBackgroundImage(`  ${PNG_DATA_URL}  `)).toBe(PNG_DATA_URL)
  })

  it('drops non-string, empty, and non-image values', () => {
    expect(normalizeTerminalBackgroundImage(undefined)).toBeUndefined()
    expect(normalizeTerminalBackgroundImage(42)).toBeUndefined()
    expect(normalizeTerminalBackgroundImage('')).toBeUndefined()
    expect(normalizeTerminalBackgroundImage('/Users/me/Pictures/bg.png')).toBeUndefined()
    expect(normalizeTerminalBackgroundImage('file:///tmp/bg.png')).toBeUndefined()
    expect(normalizeTerminalBackgroundImage('data:text/html;base64,PHNjcmlwdD4=')).toBeUndefined()
  })

  it('rejects non-base64 raster payloads', () => {
    expect(normalizeTerminalBackgroundImage('data:image/png,abc')).toBeUndefined()
  })

  it('rejects oversized payloads', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_TERMINAL_BACKGROUND_IMAGE_DATA_URL_LENGTH)}`
    expect(normalizeTerminalBackgroundImage(huge)).toBeUndefined()
  })
})

describe('normalizeTerminalBackgroundImageOpacity', () => {
  it('clamps to the unit range and drops non-finite values', () => {
    expect(normalizeTerminalBackgroundImageOpacity(0.3)).toBe(0.3)
    expect(normalizeTerminalBackgroundImageOpacity(-1)).toBe(0)
    expect(normalizeTerminalBackgroundImageOpacity(7)).toBe(1)
    expect(normalizeTerminalBackgroundImageOpacity(Number.NaN)).toBeUndefined()
    expect(normalizeTerminalBackgroundImageOpacity('0.5')).toBeUndefined()
  })
})

describe('normalizeTerminalBackgroundImageFit', () => {
  it('accepts only known fit modes', () => {
    expect(normalizeTerminalBackgroundImageFit('cover')).toBe('cover')
    expect(normalizeTerminalBackgroundImageFit('contain')).toBe('contain')
    expect(normalizeTerminalBackgroundImageFit('stretch')).toBe('stretch')
    expect(normalizeTerminalBackgroundImageFit('center')).toBe('center')
    expect(normalizeTerminalBackgroundImageFit('tile')).toBeUndefined()
    expect(normalizeTerminalBackgroundImageFit(undefined)).toBeUndefined()
  })
})

describe('sanitizeTerminalBackgroundImageSettings', () => {
  it('copies only the keys present in the update, sanitized', () => {
    const target: TerminalBackgroundImageSettings = {}

    sanitizeTerminalBackgroundImageSettings(
      { terminalBackgroundImage: PNG_DATA_URL, terminalBackgroundImageOpacity: 3 },
      target
    )

    expect(target).toEqual({
      terminalBackgroundImage: PNG_DATA_URL,
      terminalBackgroundImageOpacity: 1
    })
    expect('terminalBackgroundImageFit' in target).toBe(false)
  })

  it('writes undefined for an explicit clear so the stored value is removed', () => {
    const target: TerminalBackgroundImageSettings = { terminalBackgroundImage: PNG_DATA_URL }

    sanitizeTerminalBackgroundImageSettings({ terminalBackgroundImage: undefined }, target)

    expect('terminalBackgroundImage' in target).toBe(true)
    expect(target.terminalBackgroundImage).toBeUndefined()
  })
})

describe('resolveTerminalBackgroundImageCss', () => {
  it('defaults to cover and maps each fit to background-size', () => {
    expect(resolveTerminalBackgroundImageCss(undefined).size).toBe('cover')
    expect(resolveTerminalBackgroundImageCss('contain').size).toBe('contain')
    expect(resolveTerminalBackgroundImageCss('stretch').size).toBe('100% 100%')
    expect(resolveTerminalBackgroundImageCss('center').size).toBe('auto')
  })
})
