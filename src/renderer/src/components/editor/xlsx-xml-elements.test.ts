import { describe, expect, it } from 'vitest'
import {
  decodeXlsxXmlText,
  forEachXlsxXmlElement,
  parseXlsxXmlAttributes,
  readXlsxXmlTextRuns
} from './xlsx-xml-elements'

function collect(
  xml: string,
  tagName: string
): { attributes: Record<string, string>; inner: string }[] {
  const elements: { attributes: Record<string, string>; inner: string }[] = []
  forEachXlsxXmlElement(xml, tagName, (element) => {
    elements.push(element)
  })
  return elements
}

describe('forEachXlsxXmlElement', () => {
  it('visits elements in document order with their attributes and inner XML', () => {
    const elements = collect('<row r="1"><c r="A1"><v>7</v></c></row><row r="2"/>', 'row')

    expect(elements).toEqual([
      { attributes: { r: '1' }, inner: '<c r="A1"><v>7</v></c>' },
      { attributes: { r: '2' }, inner: '' }
    ])
  })

  it('does not match a longer tag that shares the same prefix', () => {
    const xml = '<cols><col min="1"/></cols><row><c r="A1"><v>1</v></c></row>'

    expect(collect(xml, 'c')).toEqual([{ attributes: { r: 'A1' }, inner: '<v>1</v>' }])
  })

  it('does not match a shorter tag that the name starts with', () => {
    expect(collect('<sheets><sheet name="One"/></sheets>', 'sheet')).toEqual([
      { attributes: { name: 'One' }, inner: '' }
    ])
  })

  it('closes against the matching tag when the same element nests', () => {
    const xml = '<a id="outer"><a id="inner">deep</a>tail</a>'

    expect(collect(xml, 'a')).toEqual([
      { attributes: { id: 'outer' }, inner: '<a id="inner">deep</a>tail' }
    ])
  })

  it('does not treat a self-closing element as an extra nesting level', () => {
    const xml = '<a id="outer"><a id="void"/>tail</a><a id="next">x</a>'

    expect(collect(xml, 'a')).toEqual([
      { attributes: { id: 'outer' }, inner: '<a id="void"/>tail' },
      { attributes: { id: 'next' }, inner: 'x' }
    ])
  })

  it('stops early when the visitor returns false', () => {
    const visited: string[] = []
    forEachXlsxXmlElement('<row r="1"/><row r="2"/><row r="3"/>', 'row', (element) => {
      visited.push(element.attributes.r ?? '')
      return visited.length < 2
    })

    expect(visited).toEqual(['1', '2'])
  })

  it('keeps whitespace and newlines inside an element intact', () => {
    expect(collect('<t xml:space="preserve">  two words\n</t>', 't')).toEqual([
      { attributes: { 'xml:space': 'preserve' }, inner: '  two words\n' }
    ])
  })

  it('tolerates an element left unterminated by a truncated part', () => {
    expect(collect('<row r="9"><c r="A9"><v>5</v>', 'row')).toEqual([
      { attributes: { r: '9' }, inner: '<c r="A9"><v>5</v>' }
    ])
  })

  it('returns nothing for a part that never opens the element', () => {
    expect(collect('<worksheet><sheetData/></worksheet>', 'row')).toEqual([])
  })

  it('does not end the open tag at a > inside an attribute value', () => {
    // Why: XML only requires < and & to be escaped in a value, so > is legal
    // there. Ending the tag at the first > would truncate attribute parsing.
    expect(collect('<c r="A1" t="s" note="a > b"><v>1</v></c>', 'c')).toEqual([
      { attributes: { r: 'A1', t: 's', note: 'a > b' }, inner: '<v>1</v>' }
    ])
  })

  it('does not treat a value ending in a slash as a self-closing tag', () => {
    expect(
      collect('<Relationship Id="rId1" Target="https://host/">text</Relationship>', 'Relationship')
    ).toEqual([{ attributes: { Id: 'rId1', Target: 'https://host/' }, inner: 'text' }])
  })

  it('does not loop forever on an open tag that is never closed with >', () => {
    expect(collect('<row r="1"', 'row')).toEqual([])
  })
})

describe('parseXlsxXmlAttributes', () => {
  it('reads double-quoted, single-quoted and namespaced attributes', () => {
    expect(parseXlsxXmlAttributes(` r="A1" t='s' s="3" xml:space="preserve"`)).toEqual({
      r: 'A1',
      t: 's',
      s: '3',
      'xml:space': 'preserve'
    })
  })

  it('decodes entities inside attribute values', () => {
    expect(parseXlsxXmlAttributes('name="Q1 &amp; Q2" formatCode="&quot;kg&quot;"')).toEqual({
      name: 'Q1 & Q2',
      formatCode: '"kg"'
    })
  })

  it('keeps a value that legally contains the other quote character', () => {
    expect(parseXlsxXmlAttributes(`name="Bob's sheet"`)).toEqual({ name: "Bob's sheet" })
  })

  it('tolerates whitespace around the equals sign', () => {
    expect(parseXlsxXmlAttributes('r = "B2"')).toEqual({ r: 'B2' })
  })

  it('returns an empty record for an element with no attributes', () => {
    expect(parseXlsxXmlAttributes('')).toEqual({})
  })
})

describe('decodeXlsxXmlText', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeXlsxXmlText('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;')).toBe(`<a> & "b" 'c'`)
  })

  it('decodes decimal and hexadecimal character references', () => {
    expect(decodeXlsxXmlText('&#65;&#x42;&#X43;&#128169;')).toBe('ABC💩')
  })

  it('leaves an unknown or out-of-range reference untouched', () => {
    expect(decodeXlsxXmlText('&nbsp;&#x110000;&#notanumber;')).toBe('&nbsp;&#x110000;&#notanumber;')
  })

  it('returns the input unchanged when it holds no reference', () => {
    expect(decodeXlsxXmlText('plain text')).toBe('plain text')
  })
})

describe('readXlsxXmlTextRuns', () => {
  it('concatenates every run of a rich-text string', () => {
    const xml = '<r><rPr><b/></rPr><t>bold</t></r><r><t xml:space="preserve"> tail</t></r>'

    expect(readXlsxXmlTextRuns(xml)).toBe('bold tail')
  })

  it('decodes entities across runs', () => {
    expect(readXlsxXmlTextRuns('<r><t>a &amp;</t></r><r><t> b</t></r>')).toBe('a & b')
  })

  it('reads an empty self-closed run as an empty string', () => {
    expect(readXlsxXmlTextRuns('<t/>')).toBe('')
  })
})
