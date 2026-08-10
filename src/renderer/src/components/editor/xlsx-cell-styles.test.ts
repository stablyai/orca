import { describe, expect, it } from 'vitest'
import { parseXlsxCellStyles } from './xlsx-cell-styles'
import { parseXlsxThemePalette } from './xlsx-theme-palette'

const OFFICE_THEME = parseXlsxThemePalette(
  '<a:clrScheme><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>'
)

// Modelled on a real workbook: a dark blue header band with white bold text, and
// a yellow input cell that declares no font colour of its own.
const STYLES_XML = `<styleSheet>
  <fonts count="3">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/></font>
    <font><sz val="11"/><color rgb="FF333333"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor rgb="FF003366"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="3" applyFill="1"/>
    <xf numFmtId="0" fontId="1" fillId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="0" fillId="1"/>
  </cellXfs>
</styleSheet>`

describe('parseXlsxCellStyles', () => {
  it('reads a solid fill and keeps a legible declared font colour', () => {
    const styles = parseXlsxCellStyles(STYLES_XML, OFFICE_THEME)

    expect(styles.getStyle(1)).toEqual({
      backgroundColor: '#1f4e78',
      textColor: '#ffffff',
      bold: true
    })
  })

  it('derives readable ink for a fill whose font colour would vanish', () => {
    // Why: the yellow input cell inherits font 0, whose theme colour is black —
    // but the same fill under a white font must not be left invisible either.
    const styles = parseXlsxCellStyles(STYLES_XML, OFFICE_THEME)

    expect(styles.getStyle(2)).toEqual({ backgroundColor: '#ffff00', textColor: '#000000' })
  })

  it('reports bold without a fill, and leaves the text colour to the theme', () => {
    // Why: without a known background we cannot verify contrast, so the app's own
    // foreground stays in charge rather than risking unreadable text.
    const styles = parseXlsxCellStyles(STYLES_XML, OFFICE_THEME)

    expect(styles.getStyle(3)).toEqual({ bold: true })
    expect(styles.getStyle(4)).toBeUndefined()
  })

  it('gives an unstyled cell format no style at all', () => {
    const styles = parseXlsxCellStyles(STYLES_XML, OFFICE_THEME)

    expect(styles.getStyle(0)).toBeUndefined()
    expect(styles.getStyle(undefined)).toBeUndefined()
    expect(styles.getStyle(99)).toBeUndefined()
  })

  it('ignores a hatch pattern rather than painting it as a solid block', () => {
    // gray125 is a 12.5% dotted texture; a solid fill would invent a colour.
    const styles = parseXlsxCellStyles(STYLES_XML, OFFICE_THEME)

    expect(styles.getStyle(5)).toBeUndefined()
  })

  it('returns the same object for repeated lookups of one style index', () => {
    // Why: a sheet stores one reference per cell, so 200k styled cells must not
    // allocate 200k style objects.
    const styles = parseXlsxCellStyles(STYLES_XML, OFFICE_THEME)

    expect(styles.getStyle(1)).toBe(styles.getStyle(1))
  })

  it('reports whether the workbook has any visual styling', () => {
    expect(parseXlsxCellStyles(STYLES_XML, OFFICE_THEME).hasVisualStyles).toBe(true)
    expect(
      parseXlsxCellStyles(
        '<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0"/></cellXfs></styleSheet>',
        []
      ).hasVisualStyles
    ).toBe(false)
    expect(parseXlsxCellStyles('', []).hasVisualStyles).toBe(false)
  })

  it('resolves a themed fill colour through the theme part', () => {
    const styles = parseXlsxCellStyles(
      '<styleSheet><fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill></fills><cellXfs count="1"><xf fillId="1"/></cellXfs></styleSheet>',
      OFFICE_THEME
    )

    expect(styles.getStyle(0)?.backgroundColor).toBe('#4472c4')
  })

  it('leaves a themed fill unresolved when the theme part is missing', () => {
    const styles = parseXlsxCellStyles(
      '<styleSheet><fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill></fills><cellXfs count="1"><xf fillId="1"/></cellXfs></styleSheet>',
      []
    )

    expect(styles.getStyle(0)).toBeUndefined()
  })

  it('honours an explicit bold-off override', () => {
    const styles = parseXlsxCellStyles(
      '<styleSheet><fonts count="1"><font><b val="0"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf fontId="0" fillId="0"/></cellXfs></styleSheet>',
      []
    )

    expect(styles.getStyle(0)).toBeUndefined()
  })
})

describe('parseXlsxCellStyles alignment', () => {
  const ALIGNED_STYLES_XML =
    '<styleSheet><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="5"><xf/><xf applyAlignment="1"><alignment horizontal="center"/></xf><xf applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf applyAlignment="1"><alignment horizontal="justify"/></xf><xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>'

  it('reports the horizontal alignment the author set', () => {
    const styles = parseXlsxCellStyles(ALIGNED_STYLES_XML, [])

    expect(styles.getStyle(1)).toEqual({ horizontalAlignment: 'center' })
    expect(styles.getStyle(2)).toEqual({ horizontalAlignment: 'right', wrapText: true })
  })

  it('ignores alignments a read-only cell cannot express', () => {
    // Why: `justify` and `distributed` have no counterpart here, and `general`
    // means "infer from the value", which the viewer already does.
    expect(parseXlsxCellStyles(ALIGNED_STYLES_XML, []).getStyle(3)).toBeUndefined()
  })

  it('reports wrapText on its own', () => {
    expect(parseXlsxCellStyles(ALIGNED_STYLES_XML, []).getStyle(4)).toEqual({ wrapText: true })
  })

  it('counts alignment as visual styling', () => {
    expect(parseXlsxCellStyles(ALIGNED_STYLES_XML, []).hasVisualStyles).toBe(true)
  })
})
