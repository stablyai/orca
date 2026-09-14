import { describe, expect, it } from 'vitest'
import { isSafeLinkTarget } from './OfficeDocumentViewer'

describe('isSafeLinkTarget', () => {
  it('rejects script-capable absolute schemes', () => {
    expect(isSafeLinkTarget('javascript:alert(1)')).toBe(false)
    expect(isSafeLinkTarget('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isSafeLinkTarget(' data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeLinkTarget('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeLinkTarget('file:///C:/Windows/System32/calc.exe')).toBe(false)
    // Leading control chars must not hide the scheme.
    expect(isSafeLinkTarget('\tjavascript:alert(1)')).toBe(false)
    expect(isSafeLinkTarget('\n\t javascript:alert(1)')).toBe(false)
  })

  it('allows http(s) and mailto targets', () => {
    expect(isSafeLinkTarget('https://example.com/a')).toBe(true)
    expect(isSafeLinkTarget('http://example.com')).toBe(true)
    expect(isSafeLinkTarget('mailto:dev@example.com')).toBe(true)
  })

  it('allows relative and fragment links', () => {
    expect(isSafeLinkTarget('docs/page.html')).toBe(true)
    expect(isSafeLinkTarget('#bookmark')).toBe(true)
    expect(isSafeLinkTarget('')).toBe(true)
  })
})
