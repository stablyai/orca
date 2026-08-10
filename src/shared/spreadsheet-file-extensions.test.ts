import { describe, expect, it } from 'vitest'
import {
  MAX_PREVIEWABLE_SPREADSHEET_SIZE,
  SPREADSHEET_FILE_EXTENSIONS,
  SPREADSHEET_FILE_MIME_TYPES,
  isSpreadsheetMimeType,
  resolvePreviewableBinaryByteLimit
} from './spreadsheet-file-extensions'

const PREVIEWABLE_BINARY_LIMIT = 50 * 1024 * 1024

describe('SPREADSHEET_FILE_MIME_TYPES', () => {
  it('covers the OOXML workbook extensions with lowercase keys', () => {
    expect(SPREADSHEET_FILE_EXTENSIONS).toEqual(['.xlsx', '.xlsm'])
    for (const extension of SPREADSHEET_FILE_EXTENSIONS) {
      expect(extension).toBe(extension.toLowerCase())
    }
  })

  it('does not claim the legacy binary .xls format the viewer cannot read', () => {
    expect(SPREADSHEET_FILE_MIME_TYPES['.xls']).toBeUndefined()
    expect(SPREADSHEET_FILE_MIME_TYPES['.xlsb']).toBeUndefined()
  })
})

describe('isSpreadsheetMimeType', () => {
  it('accepts every declared workbook mime type', () => {
    for (const mimeType of Object.values(SPREADSHEET_FILE_MIME_TYPES)) {
      expect(isSpreadsheetMimeType(mimeType)).toBe(true)
    }
  })

  it('rejects other previewable binaries and missing values', () => {
    expect(isSpreadsheetMimeType('image/png')).toBe(false)
    expect(isSpreadsheetMimeType('application/pdf')).toBe(false)
    expect(isSpreadsheetMimeType('application/vnd.ms-excel')).toBe(false)
    expect(isSpreadsheetMimeType(undefined)).toBe(false)
    expect(isSpreadsheetMimeType(null)).toBe(false)
    expect(isSpreadsheetMimeType('')).toBe(false)
  })
})

describe('resolvePreviewableBinaryByteLimit', () => {
  it('caps workbooks below the general previewable-binary budget', () => {
    expect(
      resolvePreviewableBinaryByteLimit(
        SPREADSHEET_FILE_MIME_TYPES['.xlsx']!,
        PREVIEWABLE_BINARY_LIMIT
      )
    ).toBe(MAX_PREVIEWABLE_SPREADSHEET_SIZE)
    expect(MAX_PREVIEWABLE_SPREADSHEET_SIZE).toBeLessThan(PREVIEWABLE_BINARY_LIMIT)
  })

  it('leaves images and PDFs on the general budget', () => {
    expect(resolvePreviewableBinaryByteLimit('image/png', PREVIEWABLE_BINARY_LIMIT)).toBe(
      PREVIEWABLE_BINARY_LIMIT
    )
    expect(resolvePreviewableBinaryByteLimit('application/pdf', PREVIEWABLE_BINARY_LIMIT)).toBe(
      PREVIEWABLE_BINARY_LIMIT
    )
  })

  it('never raises a caller limit that is already tighter', () => {
    // Why: a transport with a smaller frame budget must stay authoritative.
    const tighterLimit = 4 * 1024 * 1024
    expect(
      resolvePreviewableBinaryByteLimit(SPREADSHEET_FILE_MIME_TYPES['.xlsm']!, tighterLimit)
    ).toBe(tighterLimit)
  })
})
