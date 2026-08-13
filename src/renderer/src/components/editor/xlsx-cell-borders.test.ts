import { describe, expect, it } from 'vitest'
import { parseXlsxCellBorders } from './xlsx-cell-borders'

const BORDERS_XML = `<styleSheet><borders count="5">
  <border/>
  <border><bottom style="thin"><color rgb="FFCCCCCC"/></bottom></border>
  <border><top style="hair"><color rgb="FFD9D9D9"/></top><bottom style="hair"><color rgb="FFD9D9D9"/></bottom></border>
  <border><left style="medium"/><right style="double"><color rgb="FF000000"/></right></border>
  <border><top style="none"/><bottom/></border>
</borders></styleSheet>`

describe('parseXlsxCellBorders', () => {
  it('reads a single declared edge with its colour', () => {
    const borders = parseXlsxCellBorders(BORDERS_XML, [])

    expect(borders[1]).toEqual({
      bottom: { width: '1px', style: 'solid', color: '#cccccc' }
    })
  })

  it('reads several edges of one border', () => {
    const borders = parseXlsxCellBorders(BORDERS_XML, [])

    expect(borders[2]).toEqual({
      top: { width: '1px', style: 'solid', color: '#d9d9d9' },
      bottom: { width: '1px', style: 'solid', color: '#d9d9d9' }
    })
  })

  it('maps weights and dash styles to their CSS equivalents', () => {
    const borders = parseXlsxCellBorders(BORDERS_XML, [])

    expect(borders[3]?.left).toEqual({ width: '2px', style: 'solid', color: undefined })
    expect(borders[3]?.right).toEqual({ width: '3px', style: 'double', color: '#000000' })
  })

  it('treats an empty border and a none style as drawing nothing', () => {
    // Why: Excel writes the empty element on every cell that sets any other edge.
    const borders = parseXlsxCellBorders(BORDERS_XML, [])

    expect(borders[0]).toBeUndefined()
    expect(borders[4]).toBeUndefined()
  })

  it('returns nothing for a missing styles part', () => {
    expect(parseXlsxCellBorders('', [])).toEqual([])
  })
})
