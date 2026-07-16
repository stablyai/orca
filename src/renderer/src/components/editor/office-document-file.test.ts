import { describe, expect, it } from 'vitest'
import { getOfficeDocumentExtension, isOfficeDocumentPath } from './office-document-file'

describe('office document file detection', () => {
  it.each(['notes.docx', 'deck.pptx', 'budget.xlsx', 'REPORT.DOCX'])(
    'recognizes %s as an Office preview file',
    (filePath) => {
      expect(isOfficeDocumentPath(filePath)).toBe(true)
    }
  )

  it.each(['notes.doc', 'deck.ppt', 'budget.xls', 'archive.zip', 'docx'])(
    'does not route %s to the Office previewer',
    (filePath) => {
      expect(isOfficeDocumentPath(filePath)).toBe(false)
    }
  )

  it('returns the normalized Office extension for parser routing', () => {
    expect(getOfficeDocumentExtension('C:\\repo\\Quarterly.PPTX')).toBe('pptx')
    expect(getOfficeDocumentExtension('/repo/report.pdf')).toBeNull()
  })
})
