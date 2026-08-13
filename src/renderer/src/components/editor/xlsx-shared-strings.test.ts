import { describe, expect, it } from 'vitest'
import { parseXlsxSharedStrings } from './xlsx-shared-strings'

describe('parseXlsxSharedStrings', () => {
  it('reads plain strings in index order', () => {
    const xml = '<sst count="2"><si><t>First</t></si><si><t>Second</t></si></sst>'

    expect(parseXlsxSharedStrings(xml)).toEqual(['First', 'Second'])
  })

  it('joins the runs of a rich-text string', () => {
    const xml =
      '<sst><si><r><rPr><b/></rPr><t xml:space="preserve">Total </t></r><r><t>2025</t></r></si></sst>'

    expect(parseXlsxSharedStrings(xml)).toEqual(['Total 2025'])
  })

  it('keeps an empty string in the table so later indexes stay aligned', () => {
    const xml = '<sst><si><t/></si><si><t>Second</t></si></sst>'

    expect(parseXlsxSharedStrings(xml)).toEqual(['', 'Second'])
  })

  it('decodes escaped markup and newlines', () => {
    const xml = '<sst><si><t>a &lt;b&gt; &amp; c&#10;d</t></si></sst>'

    expect(parseXlsxSharedStrings(xml)).toEqual(['a <b> & c\nd'])
  })

  it('drops phonetic runs so furigana does not leak into the value', () => {
    const xml =
      '<sst><si><t>課税</t><rPh sb="0" eb="2"><t>カゼイ</t></rPh><phoneticPr fontId="1"/></si></sst>'

    expect(parseXlsxSharedStrings(xml)).toEqual(['課税'])
  })

  it('drops a self-closed phonetic run without dropping the value', () => {
    const xml = '<sst><si><t>課税</t><rPh sb="0" eb="2"/></si></sst>'

    expect(parseXlsxSharedStrings(xml)).toEqual(['課税'])
  })

  it('returns an empty table for a missing or empty part', () => {
    expect(parseXlsxSharedStrings('')).toEqual([])
    expect(parseXlsxSharedStrings('<sst count="0"/>')).toEqual([])
  })
})
