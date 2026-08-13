import { describe, expect, it } from 'vitest'
import { resolveXlsxFontFamily } from './xlsx-font-family'

const FALLBACK_STACK = 'ui-sans-serif, system-ui, sans-serif'

describe('resolveXlsxFontFamily', () => {
  it('quotes a plain typeface name and keeps a fallback stack behind it', () => {
    expect(resolveXlsxFontFamily('Arial')).toBe(`"Arial", ${FALLBACK_STACK}`)
  })

  it('accepts a multi-word name such as the one a real workbook declares', () => {
    expect(resolveXlsxFontFamily('Century Gothic')).toBe(`"Century Gothic", ${FALLBACK_STACK}`)
  })

  it('accepts a hyphen and an underscore inside the name', () => {
    expect(resolveXlsxFontFamily('Helvetica-Neue')).toBe(`"Helvetica-Neue", ${FALLBACK_STACK}`)
    expect(resolveXlsxFontFamily('My_Font')).toBe(`"My_Font", ${FALLBACK_STACK}`)
  })

  it('accepts digits inside the name', () => {
    expect(resolveXlsxFontFamily('Arial2')).toBe(`"Arial2", ${FALLBACK_STACK}`)
    expect(resolveXlsxFontFamily('Font 12')).toBe(`"Font 12", ${FALLBACK_STACK}`)
  })

  it('resolves nothing for a font the workbook never names', () => {
    expect(resolveXlsxFontFamily(undefined)).toBeUndefined()
  })

  it('resolves nothing for an empty or blank name', () => {
    expect(resolveXlsxFontFamily('')).toBeUndefined()
    expect(resolveXlsxFontFamily('   ')).toBeUndefined()
  })

  it('trims the surrounding whitespace instead of rejecting the name', () => {
    expect(resolveXlsxFontFamily('  Arial  ')).toBe(resolveXlsxFontFamily('Arial'))
  })

  it.each([
    ['a double quote', 'Arial"'],
    ['a single quote', "Arial'"],
    ['a semicolon', 'Arial; x'],
    ['parentheses', 'url(x)'],
    ['braces', 'Arial{color:red}'],
    ['a comma', 'Arial, serif'],
    ['a slash', 'Arial/serif'],
    ['an angle bracket', 'Arial<script>'],
    ['a closing angle bracket', 'Arial>'],
    ['a newline', 'Arial\nserif'],
    ['a style injection lifted from a crafted file', 'Arial"; background:url(x)']
  ])('rejects rather than escapes a name carrying %s', (_case, name) => {
    expect(resolveXlsxFontFamily(name)).toBeUndefined()
  })

  it('rejects a name that does not start with an alphanumeric character', () => {
    expect(resolveXlsxFontFamily('-Arial')).toBeUndefined()
    expect(resolveXlsxFontFamily('_Arial')).toBeUndefined()
  })

  it('accepts a name of exactly sixty-four characters and rejects a longer one', () => {
    expect(resolveXlsxFontFamily('A'.repeat(64))).toBe(`"${'A'.repeat(64)}", ${FALLBACK_STACK}`)
    expect(resolveXlsxFontFamily('A'.repeat(65))).toBeUndefined()
  })

  it('rejects an accented or CJK typeface name, a known limit of the ASCII allowlist', () => {
    expect(resolveXlsxFontFamily('Ñoño')).toBeUndefined()
    expect(resolveXlsxFontFamily('黑体')).toBeUndefined()
  })
})
