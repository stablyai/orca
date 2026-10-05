import { describe, expect, it } from 'vitest'
import {
  isOpenInAppIconImageSrc,
  normalizeOpenInAppIcon,
  MAX_OPEN_IN_APP_ICON_DATA_URL_LENGTH
} from './open-in-app-icons'

const PNG_1X1_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A bare PNG header, enough for the dimension reader the decode-bomb guard uses. */
function pngHeaderDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

describe('isOpenInAppIconImageSrc', () => {
  it('accepts the PNG data URL shape icon extraction produces', () => {
    expect(isOpenInAppIconImageSrc(PNG_1X1_DATA_URL)).toBe(true)
    expect(isOpenInAppIconImageSrc(pngHeaderDataUrl(64, 64))).toBe(true)
  })

  it('accepts base64 that is not a decodable image', () => {
    // Why: this is a shape gate, not a decoder — the guarantee is "nothing scriptable,
    // nothing remote, nothing huge", and an undecodable payload only renders broken.
    // Tightening to real PNG bytes should fail here first, deliberately.
    expect(isOpenInAppIconImageSrc('data:image/png;base64,aGk=')).toBe(true)
  })

  it('rejects sources that would make a menu icon scriptable or network-dependent', () => {
    expect(isOpenInAppIconImageSrc('data:image/svg+xml;base64,aGk=')).toBe(false)
    expect(isOpenInAppIconImageSrc('https://example.com/icon.png')).toBe(false)
    expect(isOpenInAppIconImageSrc('file:///Applications/Zed.app/icon.png')).toBe(false)
    expect(isOpenInAppIconImageSrc('data:image/jpeg;base64,aGk=')).toBe(false)
  })

  it('rejects payloads that are empty or not base64', () => {
    expect(isOpenInAppIconImageSrc('data:image/png;base64,')).toBe(false)
    expect(isOpenInAppIconImageSrc('data:image/png;base64,not base64!')).toBe(false)
    expect(isOpenInAppIconImageSrc('data:image/png;base64,aGk=extra')).toBe(false)
  })

  it('rejects an icon too large to sync to paired clients', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(MAX_OPEN_IN_APP_ICON_DATA_URL_LENGTH)}`
    expect(isOpenInAppIconImageSrc(oversized)).toBe(false)
  })

  it('rejects a small payload whose header declares huge dimensions', () => {
    // The byte cap bounds the payload, not the dimensions — 24 bytes claim 65536².
    expect(isOpenInAppIconImageSrc(pngHeaderDataUrl(65_536, 65_536))).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isOpenInAppIconImageSrc(undefined)).toBe(false)
    expect(isOpenInAppIconImageSrc(null)).toBe(false)
    expect(isOpenInAppIconImageSrc({ src: PNG_1X1_DATA_URL })).toBe(false)
  })
})

describe('normalizeOpenInAppIcon', () => {
  it('keeps a bundled icon this build ships', () => {
    expect(normalizeOpenInAppIcon({ type: 'bundled', id: 'Braces' })).toEqual({
      type: 'bundled',
      id: 'Braces'
    })
  })

  it('keeps an extracted icon and drops its extra fields', () => {
    expect(normalizeOpenInAppIcon({ type: 'image', src: PNG_1X1_DATA_URL, label: 'Zed' })).toEqual({
      type: 'image',
      src: PNG_1X1_DATA_URL
    })
  })

  it('drops an icon a newer client wrote', () => {
    // Degrading to the command preset beats rendering a blank slot.
    expect(normalizeOpenInAppIcon({ type: 'bundled', id: 'NotAnIcon' })).toBeNull()
    expect(normalizeOpenInAppIcon({ type: 'emoji', emoji: '🚀' })).toBeNull()
    expect(
      normalizeOpenInAppIcon({ type: 'image', src: 'https://example.com/icon.png' })
    ).toBeNull()
  })

  it('drops values that are not an icon at all', () => {
    expect(normalizeOpenInAppIcon('Braces')).toBeNull()
    expect(normalizeOpenInAppIcon(null)).toBeNull()
    expect(normalizeOpenInAppIcon(undefined)).toBeNull()
    expect(normalizeOpenInAppIcon({})).toBeNull()
  })
})
