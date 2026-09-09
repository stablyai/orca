import { describe, expect, it } from 'vitest'
import { BINARY_FILE_EXTENSIONS } from './binary-file-extensions'
import {
  OFFICE_FORMAT_LABELS,
  OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS,
  OFFICE_RENDERABLE_EXTENSIONS,
  isIdentifiedUnrenderableOffice,
  isOfficeDocument,
  isOfficeRenderable,
  officeDocKind,
  officeFileExtension,
  officeKindSupportsSelection
} from './office-file-extensions'

describe('office file extensions', () => {
  it('renders the three OOXML formats and their macro-enabled twins', () => {
    for (const extension of ['.docx', '.xlsx', '.pptx', '.docm', '.xlsm', '.pptm']) {
      expect(isOfficeRenderable(`/w/report${extension}`)).toBe(true)
    }
  })

  it('identifies legacy and ODF formats without claiming it can render them', () => {
    for (const extension of OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS) {
      expect(isOfficeRenderable(`/w/report${extension}`)).toBe(false)
      expect(isIdentifiedUnrenderableOffice(`/w/report${extension}`)).toBe(true)
      expect(isOfficeDocument(`/w/report${extension}`)).toBe(true)
    }
  })

  it('never routes CSV to Office rendering', () => {
    // Orca's own CSV viewer owns this format and officecli rejects it outright.
    expect(isOfficeDocument('/w/data.csv')).toBe(false)
  })

  it('is case-insensitive and splits Windows paths', () => {
    expect(officeFileExtension('C:\\Users\\me\\Deck.PPTX')).toBe('.pptx')
    expect(officeDocKind('C:\\Users\\me\\Deck.PPTX')).toBe('ppt')
    expect(officeDocKind('/w/.hidden')).toBeNull()
    expect(officeDocKind('/w/no-extension')).toBeNull()
  })

  it('maps every known extension to a kind', () => {
    for (const extension of [
      ...OFFICE_RENDERABLE_EXTENSIONS,
      ...OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS
    ]) {
      expect(officeDocKind(`/w/f${extension}`)).not.toBeNull()
    }
  })

  it('keeps the renderable and unrenderable tables disjoint', () => {
    const overlap = OFFICE_RENDERABLE_EXTENSIONS.filter((extension) =>
      (OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS as readonly string[]).includes(extension)
    )
    expect(overlap).toEqual([])
  })

  it('names every unrenderable format for the reader', () => {
    for (const extension of OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS) {
      expect(OFFICE_FORMAT_LABELS[extension]).toBeTruthy()
    }
  })

  it('stays consistent with the binary-extension table', () => {
    // A format renderable here but unknown as binary would open in the text editor as mojibake.
    for (const extension of [
      ...OFFICE_RENDERABLE_EXTENSIONS,
      ...OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS
    ]) {
      expect(BINARY_FILE_EXTENSIONS).toContain(extension)
    }
  })

  it('reports that spreadsheets have no addressable selection', () => {
    expect(officeKindSupportsSelection('excel')).toBe(false)
    expect(officeKindSupportsSelection('word')).toBe(true)
    expect(officeKindSupportsSelection('ppt')).toBe(true)
  })
})
