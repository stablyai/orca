import { describe, expect, it } from 'vitest'
import {
  backgroundImageFileMime,
  isBackgroundImageStorageId,
  normalizeTerminalBackgroundImage
} from './terminal-background-image'

const VALID_ID = '01234567-89ab-4cde-8f01-23456789abcd'

function validReference(): Record<string, unknown> {
  return {
    id: VALID_ID,
    fileName: `${VALID_ID}.png`,
    mimeType: 'image/png',
    label: 'sunset'
  }
}

describe('normalizeTerminalBackgroundImage', () => {
  it('accepts a valid main-minted reference', () => {
    expect(normalizeTerminalBackgroundImage(validReference())).toEqual({
      id: VALID_ID,
      fileName: `${VALID_ID}.png`,
      mimeType: 'image/png',
      label: 'sunset'
    })
  })

  it('accepts every allowlisted extension with its matching mime', () => {
    const cases: [string, string][] = [
      ['.png', 'image/png'],
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp']
    ]
    for (const [ext, mimeType] of cases) {
      const result = normalizeTerminalBackgroundImage({
        id: VALID_ID,
        fileName: `${VALID_ID}${ext}`,
        mimeType
      })
      expect(result?.mimeType).toBe(mimeType)
    }
  })

  it('trims the label and caps its length', () => {
    const result = normalizeTerminalBackgroundImage({
      ...validReference(),
      label: `  ${'x'.repeat(200)}  `
    })
    expect(result?.label).toBe('x'.repeat(80))
  })

  it('omits the label when empty or not a string', () => {
    expect(
      normalizeTerminalBackgroundImage({ ...validReference(), label: '   ' })?.label
    ).toBeUndefined()
    expect(
      normalizeTerminalBackgroundImage({ ...validReference(), label: 42 })?.label
    ).toBeUndefined()
  })

  it('rejects non-object input', () => {
    for (const value of [null, undefined, 'image.png', 42, true, [validReference()]]) {
      expect(normalizeTerminalBackgroundImage(value)).toBeNull()
    }
  })

  it('rejects non-UUID ids', () => {
    for (const id of ['', 'not-a-uuid', '../evil', `${VALID_ID}x`]) {
      expect(normalizeTerminalBackgroundImage({ ...validReference(), id })).toBeNull()
    }
  })

  it('rejects fileNames not minted from the id', () => {
    const otherId = 'fedcba98-7654-4321-8fed-cba987654321'
    for (const fileName of [
      `${otherId}.png`,
      `../../${VALID_ID}.png`,
      `${VALID_ID}`,
      `${VALID_ID}.png.exe`
    ]) {
      expect(normalizeTerminalBackgroundImage({ ...validReference(), fileName })).toBeNull()
    }
  })

  it('rejects disallowed extensions', () => {
    for (const ext of ['.svg', '.exe', '.txt', '.bmp']) {
      expect(
        normalizeTerminalBackgroundImage({
          ...validReference(),
          fileName: `${VALID_ID}${ext}`
        })
      ).toBeNull()
    }
  })

  it('rejects a mimeType that does not match the extension', () => {
    expect(
      normalizeTerminalBackgroundImage({ ...validReference(), mimeType: 'image/jpeg' })
    ).toBeNull()
    expect(
      normalizeTerminalBackgroundImage({ ...validReference(), mimeType: 'text/html' })
    ).toBeNull()
  })

  it('omits an extension-only label like ".png"', () => {
    expect(
      normalizeTerminalBackgroundImage({ ...validReference(), label: '.png' })?.label
    ).toBeUndefined()
  })
})

describe('isBackgroundImageStorageId', () => {
  it('accepts a UUID and rejects everything else', () => {
    expect(isBackgroundImageStorageId(VALID_ID)).toBe(true)
    for (const value of ['', 'not-a-uuid', '../evil', `${VALID_ID}x`, 42, null, undefined]) {
      expect(isBackgroundImageStorageId(value)).toBe(false)
    }
  })
})

describe('backgroundImageFileMime', () => {
  it('returns the mime for an id-minted allowlisted filename', () => {
    expect(backgroundImageFileMime(VALID_ID, `${VALID_ID}.png`)).toBe('image/png')
    expect(backgroundImageFileMime(VALID_ID, `${VALID_ID}.webp`)).toBe('image/webp')
  })

  it('rejects disallowed extensions, foreign ids, and non-strings', () => {
    expect(backgroundImageFileMime(VALID_ID, `${VALID_ID}.json`)).toBeNull()
    expect(backgroundImageFileMime(VALID_ID, `${VALID_ID}.png.exe`)).toBeNull()
    expect(backgroundImageFileMime(VALID_ID, `${VALID_ID}.`)).toBeNull()
    expect(backgroundImageFileMime(VALID_ID, `other.png`)).toBeNull()
    expect(backgroundImageFileMime('../evil', '../evil.png')).toBeNull()
    expect(backgroundImageFileMime(VALID_ID, 42)).toBeNull()
  })
})
