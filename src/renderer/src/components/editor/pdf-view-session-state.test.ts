import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetPdfViewSessionStateForTest,
  getPdfViewSession,
  setPdfViewSession
} from './pdf-view-session-state'

describe('pdf-view-session-state', () => {
  beforeEach(() => {
    _resetPdfViewSessionStateForTest()
  })

  it('stores and restores the scale preference for a file path', () => {
    setPdfViewSession('/repo/doc.pdf', { scalePreference: 2 })
    expect(getPdfViewSession('/repo/doc.pdf')).toEqual({ scalePreference: 2 })
  })

  it('merges partial updates without losing the existing scale preference', () => {
    setPdfViewSession('/repo/doc.pdf', { scalePreference: 1.5 })
    setPdfViewSession('/repo/doc.pdf', {})
    expect(getPdfViewSession('/repo/doc.pdf')).toEqual({ scalePreference: 1.5 })
  })

  it('keeps separate session state per file path', () => {
    setPdfViewSession('/a.pdf', { scalePreference: 2 })
    setPdfViewSession('/b.pdf', { scalePreference: 'page-width' })
    expect(getPdfViewSession('/a.pdf')?.scalePreference).toBe(2)
    expect(getPdfViewSession('/b.pdf')?.scalePreference).toBe('page-width')
  })
})
