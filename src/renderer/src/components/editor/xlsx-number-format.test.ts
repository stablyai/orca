import { describe, expect, it } from 'vitest'
import {
  formatXlsxNumericValue,
  isGeneralXlsxFormatCode,
  parseXlsxNumberFormatCode,
  splitFormatSections
} from './xlsx-number-format'

function format(value: number, code: string, locale = 'es-ES'): string {
  const parsed = parseXlsxNumberFormatCode(code)
  expect(parsed).not.toBeNull()
  return formatXlsxNumericValue(value, parsed!, locale).text
}

describe('isGeneralXlsxFormatCode', () => {
  it('treats General and text-only codes as unformatted', () => {
    expect(isGeneralXlsxFormatCode('General')).toBe(true)
    expect(isGeneralXlsxFormatCode('general')).toBe(true)
    expect(isGeneralXlsxFormatCode('')).toBe(true)
    expect(isGeneralXlsxFormatCode('@')).toBe(true)
    expect(isGeneralXlsxFormatCode('#,##0')).toBe(false)
  })
})

describe('splitFormatSections', () => {
  it('splits on the section separator', () => {
    expect(splitFormatSections('#,##0;-#,##0;"-"')).toEqual(['#,##0', '-#,##0', '"-"'])
  })

  it('ignores separators inside quotes, brackets and escapes', () => {
    expect(splitFormatSections('0" ; "0')).toEqual(['0" ; "0'])
    expect(splitFormatSections('[$-409]0;[Red]0')).toEqual(['[$-409]0', '[Red]0'])
    expect(splitFormatSections('0\\;0')).toEqual(['0\\;0'])
  })
})

describe('formatXlsxNumericValue', () => {
  it('groups thousands and keeps the declared decimals', () => {
    expect(format(1000, '#,##0')).toBe('1.000')
    expect(format(1000, '#,##0', 'en-US')).toBe('1,000')
    expect(format(1234.5, '#,##0.00', 'en-US')).toBe('1,234.50')
  })

  it('uses the viewer locale separators, not the file', () => {
    // Why: the same code reads 1,000.00 in English and 1.000,00 in Spanish.
    expect(format(1234.5, '#,##0.00', 'es-ES')).toBe('1.234,50')
    expect(format(1234.5, '#,##0.00', 'de-DE')).toBe('1.234,50')
  })

  it('keeps a currency literal on the side the code puts it', () => {
    expect(format(1000, '#,##0\\ "€"', 'es-ES')).toBe('1.000 €')
    expect(format(1000, '"$"#,##0', 'en-US')).toBe('$1,000')
  })

  it('renders a percentage by scaling the stored fraction', () => {
    expect(format(0.5, '0%')).toBe('50%')
    expect(format(0.1234, '0.00%', 'en-US')).toBe('12.34%')
  })

  it('scales down by a thousand for each trailing comma', () => {
    expect(format(1_500_000, '#,##0,', 'en-US')).toBe('1,500')
    expect(format(1_500_000_000, '#,##0,,', 'en-US')).toBe('1,500')
  })

  it('pads to the minimum integer and decimal digits', () => {
    expect(format(5, '000')).toBe('005')
    expect(format(1.5, '0.000', 'en-US')).toBe('1.500')
  })

  it('trims optional decimals that are not needed', () => {
    expect(format(1.5, '0.##', 'en-US')).toBe('1.5')
    expect(format(1, '0.##', 'en-US')).toBe('1')
  })

  it('uses the negative section and lets it own the sign', () => {
    expect(format(-50, '#,##0;\\(#,##0\\)', 'en-US')).toBe('(50)')
    expect(format(-50, '#,##0', 'en-US')).toBe('-50')
  })

  it('uses the zero section when the value is zero', () => {
    expect(format(0, '0.00;-0.00;"—"', 'en-US')).toBe('0.00')
    const parsed = parseXlsxNumberFormatCode('0.00;-0.00;"cero"0')
    expect(formatXlsxNumericValue(0, parsed!, 'en-US').text).toBe('cero0')
  })

  it('reports the colour a section declares', () => {
    const parsed = parseXlsxNumberFormatCode('#,##0;[Red]-#,##0')

    expect(formatXlsxNumericValue(-50, parsed!, 'en-US').color).toBe('#ff0000')
    expect(formatXlsxNumericValue(50, parsed!, 'en-US').color).toBeUndefined()
  })

  it('ignores locale and condition brackets that are not colours', () => {
    expect(format(1000, '[$$-409]#,##0', 'en-US')).toBe('$1,000')
  })

  it('renders the accounting format without its fill and width padding', () => {
    // `_-* #,##0.00_-` uses a repeat-fill and reserved widths a cell cannot show.
    expect(format(1234.5, '_-* #,##0.00_-', 'en-US')).toBe(' 1,234.50 ')
  })
})

describe('parseXlsxNumberFormatCode', () => {
  it('returns null for a code with no numeric placeholder', () => {
    expect(parseXlsxNumberFormatCode('General')).toBeNull()
    expect(parseXlsxNumberFormatCode('"texto"')).toBeNull()
    expect(parseXlsxNumberFormatCode('@')).toBeNull()
  })
})
