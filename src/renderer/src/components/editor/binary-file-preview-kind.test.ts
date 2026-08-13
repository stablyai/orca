import { describe, expect, it } from 'vitest'
import { getBinaryFilePreviewKind } from './binary-file-preview-kind'
import { SPREADSHEET_FILE_MIME_TYPES } from '../../../../shared/spreadsheet-file-extensions'

const XLSX_MIME_TYPE = SPREADSHEET_FILE_MIME_TYPES['.xlsx']!
const XLSM_MIME_TYPE = SPREADSHEET_FILE_MIME_TYPES['.xlsm']!

describe('getBinaryFilePreviewKind', () => {
  it('routes workbooks to the spreadsheet viewer', () => {
    expect(getBinaryFilePreviewKind({ mimeType: XLSX_MIME_TYPE, isImage: true })).toBe(
      'spreadsheet'
    )
    expect(getBinaryFilePreviewKind({ mimeType: XLSM_MIME_TYPE, isImage: true })).toBe(
      'spreadsheet'
    )
  })

  it('routes workbooks even when the read path did not set isImage', () => {
    // Why: the flag is a legacy "previewable" marker; the SSH and local read
    // paths do not agree on it, so the mime type has to be sufficient.
    expect(getBinaryFilePreviewKind({ mimeType: XLSX_MIME_TYPE })).toBe('spreadsheet')
  })

  it('leaves images and PDFs on the image viewer', () => {
    expect(getBinaryFilePreviewKind({ mimeType: 'image/png', isImage: true })).toBe('image')
    expect(getBinaryFilePreviewKind({ mimeType: 'application/pdf', isImage: true })).toBe('image')
  })

  it('reports an unpreviewable binary', () => {
    expect(getBinaryFilePreviewKind({})).toBe('unsupported')
    expect(getBinaryFilePreviewKind({ isImage: false })).toBe('unsupported')
    expect(getBinaryFilePreviewKind({ mimeType: 'application/zip' })).toBe('unsupported')
  })

  it('does not treat a mime type that merely mentions a workbook as one', () => {
    expect(getBinaryFilePreviewKind({ mimeType: `${XLSX_MIME_TYPE}x` })).toBe('unsupported')
    expect(getBinaryFilePreviewKind({ mimeType: 'application/vnd.ms-excel' })).toBe('unsupported')
  })
})
