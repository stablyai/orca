import { describe, expect, it } from 'vitest'
import { parseXlsxDifferentialFormats } from './xlsx-differential-formats'
import { parseXlsxThemePalette } from './xlsx-theme-palette'

const OFFICE_THEME = parseXlsxThemePalette(
  '<a:clrScheme><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>'
)

function dxfs(...dxfBodies: string[]): string {
  return `<styleSheet><dxfs count="${dxfBodies.length}">${dxfBodies.map((body) => `<dxf>${body}</dxf>`).join('')}</dxfs></styleSheet>`
}

const SOLID_LIGHT_FILL =
  '<fill><patternFill patternType="solid"><fgColor indexed="64"/><bgColor rgb="FFFCECE6"/></patternFill></fill>'
const SOLID_DARK_FILL =
  '<fill><patternFill patternType="solid"><bgColor rgb="FF1F4E78"/></patternFill></fill>'

describe('parseXlsxDifferentialFormats', () => {
  it('returns nothing when the styles part declares no differential formats', () => {
    expect(parseXlsxDifferentialFormats('', OFFICE_THEME)).toEqual([])
    expect(parseXlsxDifferentialFormats('<styleSheet><fills/></styleSheet>', OFFICE_THEME)).toEqual(
      []
    )
    expect(
      parseXlsxDifferentialFormats('<styleSheet><dxfs count="0"/></styleSheet>', OFFICE_THEME)
    ).toEqual([])
  })

  it('reads the visible fill from bgColor, which is where a dxf writes it', () => {
    // Why: a dxf inverts the pattern colours, leaving fgColor as the system
    // default; reading fgColor would resolve every highlight to no colour.
    const formats = parseXlsxDifferentialFormats(dxfs(SOLID_LIGHT_FILL), OFFICE_THEME)

    expect(formats[0]?.backgroundColor).toBe('#fcece6')
  })

  it('falls back to fgColor when the pattern declares no bgColor', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs('<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>'),
      OFFICE_THEME
    )

    expect(formats[0]?.backgroundColor).toBe('#ffff00')
  })

  it('ignores a cleared or hatched pattern fill', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs(
        '<fill><patternFill patternType="none"><bgColor rgb="FFFF0000"/></patternFill></fill>',
        '<fill><patternFill patternType="gray125"><bgColor rgb="FFFF0000"/></patternFill></fill>'
      ),
      OFFICE_THEME
    )

    expect(formats[0]?.backgroundColor).toBeUndefined()
    expect(formats[1]?.backgroundColor).toBeUndefined()
  })

  it('treats a pattern with no patternType as a solid highlight', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs('<fill><patternFill><bgColor rgb="FFFCECE6"/></patternFill></fill>'),
      OFFICE_THEME
    )

    expect(formats[0]?.backgroundColor).toBe('#fcece6')
  })

  it('derives readable ink for a fill that declares no font colour', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs(SOLID_DARK_FILL, SOLID_LIGHT_FILL),
      OFFICE_THEME
    )

    expect(formats[0]?.textColor).toBe('#ffffff')
    expect(formats[1]?.textColor).toBe('#000000')
  })

  it('reports a font colour on its own when the rule paints no fill', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs('<font><color rgb="FF9C0006"/></font>'),
      OFFICE_THEME
    )

    expect(formats[0]).toEqual({ textColor: '#9c0006' })
  })

  it('reads the font toggles a rule turns on', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs('<font><b/><i/></font>', '<font><b val="1"/></font>'),
      OFFICE_THEME
    )

    expect(formats[0]).toEqual({ bold: true, italic: true })
    expect(formats[1]).toEqual({ bold: true })
  })

  it('keeps an explicit bold-off so a rule can clear the cell own bold', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs('<font><b val="0"/></font>', '<font><b val="false"/></font>'),
      OFFICE_THEME
    )

    expect(formats[0]).toEqual({ bold: false })
    expect(formats[1]).toEqual({ bold: false })
  })

  it('yields an empty override for a dxf that changes nothing visual', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs(
        '<font/><fill><patternFill patternType="none"/></fill><border/>',
        '<numFmt numFmtId="164" formatCode="0.00"/>',
        '<border><left style="thin"><color rgb="FFFF0000"/></left></border>'
      ),
      OFFICE_THEME
    )

    expect(formats).toEqual([{}, {}, {}])
  })

  it('resolves a themed fill colour through the theme palette', () => {
    const stylesXml = dxfs(
      '<fill><patternFill patternType="solid"><bgColor theme="4"/></patternFill></fill>'
    )

    expect(parseXlsxDifferentialFormats(stylesXml, OFFICE_THEME)[0]?.backgroundColor).toBe(
      '#4472c4'
    )
    expect(parseXlsxDifferentialFormats(stylesXml, [])[0]).toEqual({})
  })

  it('indexes the overrides in document order, which is what a dxfId refers to', () => {
    const formats = parseXlsxDifferentialFormats(
      dxfs(SOLID_LIGHT_FILL, SOLID_DARK_FILL, '<font><b/></font>'),
      OFFICE_THEME
    )

    expect(formats).toHaveLength(3)
    expect(formats[0]?.backgroundColor).toBe('#fcece6')
    expect(formats[1]?.backgroundColor).toBe('#1f4e78')
    expect(formats[2]).toEqual({ bold: true })
  })

  it('reads only the first dxfs block, fill and font of what it is given', () => {
    const formats = parseXlsxDifferentialFormats(
      `<styleSheet><dxfs count="1"><dxf>${SOLID_LIGHT_FILL}<fill><patternFill patternType="solid"><bgColor rgb="FF00FF00"/></patternFill></fill><font><b/></font><font><b val="0"/></font></dxf></dxfs><dxfs count="1"><dxf>${SOLID_DARK_FILL}</dxf></dxfs></styleSheet>`,
      OFFICE_THEME
    )

    expect(formats).toEqual([{ backgroundColor: '#fcece6', textColor: '#000000', bold: true }])
  })
})
