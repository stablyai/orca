import { describe, expect, it } from 'vitest'
import { expandXlsxCellRangeList } from './xlsx-cell-reference'
import type { XlsxCellStyle } from './xlsx-cell-styles'
import type { XlsxConditionalRule } from './xlsx-conditional-formatting'
import {
  applyXlsxConditionalStyles,
  type XlsxConditionalStyleInput
} from './xlsx-conditional-styles'
import type { XlsxDifferentialFormat } from './xlsx-differential-formats'

const PINK_FILL: XlsxDifferentialFormat = { backgroundColor: '#fcece6', textColor: '#000000' }
const GREEN_FILL: XlsxDifferentialFormat = { backgroundColor: '#c6efce', textColor: '#000000' }
const EMPTY_FORMAT: XlsxDifferentialFormat = {}

function rule(overrides: Partial<XlsxConditionalRule> = {}): XlsxConditionalRule {
  return {
    cells: [{ rowIndex: 0, columnIndex: 0 }],
    type: 'notContainsBlanks',
    formulas: [],
    differentialFormatId: 0,
    priority: 1,
    stopIfTrue: false,
    ...overrides
  }
}

function input(overrides: Partial<XlsxConditionalStyleInput> = {}): XlsxConditionalStyleInput {
  return {
    rules: [],
    differentialFormats: [PINK_FILL],
    rows: [['value']],
    numericValues: new Map(),
    ...overrides
  }
}

function filledRows(rowCount: number, columnCount: number, value = 'value'): string[][] {
  return Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => value))
}

function emptyStyles(rowCount: number): (XlsxCellStyle | undefined)[][] {
  return Array.from({ length: rowCount }, () => [])
}

describe('applyXlsxConditionalStyles', () => {
  it('leaves the styles untouched when the sheet has no rules', () => {
    const styles: (XlsxCellStyle | undefined)[][] = [[{ bold: true }]]

    applyXlsxConditionalStyles(styles, input())

    expect(styles).toEqual([[{ bold: true }]])
  })

  it('paints the fill and ink of the format a matching rule points at', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(styles, input({ rules: [rule()] }))

    expect(styles[0]?.[0]).toEqual(PINK_FILL)
  })

  it('keeps every property of the cell own style the rule does not override', () => {
    const base: XlsxCellStyle = {
      borders: { top: { width: '1px', style: 'solid', color: '#cccccc' } },
      horizontalAlignment: 'right',
      fontScale: 1.4,
      indent: 2,
      wrapText: true
    }
    const styles: (XlsxCellStyle | undefined)[][] = [[base]]

    applyXlsxConditionalStyles(
      styles,
      input({ rules: [rule()], differentialFormats: [{ backgroundColor: '#fcece6' }] })
    )

    expect(styles[0]?.[0]).toEqual({ ...base, backgroundColor: '#fcece6' })
  })

  it('creates a style from the format alone for a cell that carried none', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(
      styles,
      input({ rules: [rule()], differentialFormats: [{ textColor: '#9c0006' }] })
    )

    expect(styles[0]?.[0]).toEqual({ textColor: '#9c0006' })
  })

  it('replaces the background the cell own style declared', () => {
    const styles: (XlsxCellStyle | undefined)[][] = [
      [{ backgroundColor: '#ffff00', textColor: '#000000' }]
    ]

    applyXlsxConditionalStyles(styles, input({ rules: [rule()] }))

    expect(styles[0]?.[0]?.backgroundColor).toBe('#fcece6')
  })

  it('leaves the cell bold when the format says nothing about it', () => {
    const styles: (XlsxCellStyle | undefined)[][] = [[{ bold: true }]]

    applyXlsxConditionalStyles(styles, input({ rules: [rule()] }))

    expect(styles[0]?.[0]?.bold).toBe(true)
  })

  it('clears the cell bold when the format turns it off', () => {
    const styles: (XlsxCellStyle | undefined)[][] = [[{ bold: true }]]

    applyXlsxConditionalStyles(
      styles,
      input({ rules: [rule()], differentialFormats: [{ bold: false }] })
    )

    expect(styles[0]?.[0]?.bold).toBe(false)
  })

  it('ignores a rule whose dxfId points past the formats the file declares', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(styles, input({ rules: [rule({ differentialFormatId: 9 })] }))

    expect(styles[0]?.[0]).toBeUndefined()
  })

  it('paints nothing for a format that changes nothing the viewer renders', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(
      styles,
      input({ rules: [rule()], differentialFormats: [EMPTY_FORMAT] })
    )

    expect(styles[0]?.[0]).toBeUndefined()
  })

  it('lets a stopIfTrue rule that paints nothing still hold a later rule off', () => {
    // Why: authors use an empty dxf with stopIfTrue exactly to exclude a range.
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [
          rule({ priority: 1, stopIfTrue: true }),
          rule({ priority: 2, differentialFormatId: 1 })
        ],
        differentialFormats: [EMPTY_FORMAT, GREEN_FILL]
      })
    )

    expect(styles[0]?.[0]).toBeUndefined()
  })

  it('combines two rules over one cell when they touch different properties', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [rule({ priority: 1 }), rule({ priority: 2, differentialFormatId: 1 })],
        differentialFormats: [{ backgroundColor: '#fcece6' }, { bold: true }]
      })
    )

    expect(styles[0]?.[0]).toEqual({ backgroundColor: '#fcece6', textColor: '#000000', bold: true })
  })

  it('lets the later rule win where two rules set the same property', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [rule({ priority: 1 }), rule({ priority: 2, differentialFormatId: 1 })],
        differentialFormats: [PINK_FILL, GREEN_FILL]
      })
    )

    expect(styles[0]?.[0]?.backgroundColor).toBe('#c6efce')
  })

  it('stops a later rule only on the cells the stopping rule matched', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [
          rule({ priority: 1, stopIfTrue: true, cells: [{ rowIndex: 0, columnIndex: 0 }] }),
          rule({
            priority: 2,
            differentialFormatId: 1,
            cells: [
              { rowIndex: 0, columnIndex: 0 },
              { rowIndex: 0, columnIndex: 1 }
            ]
          })
        ],
        differentialFormats: [PINK_FILL, GREEN_FILL],
        rows: [['value', 'value']]
      })
    )

    expect(styles[0]?.[0]?.backgroundColor).toBe('#fcece6')
    expect(styles[0]?.[1]?.backgroundColor).toBe('#c6efce')
  })

  it('lets a later rule through when the stopIfTrue rule does not match', () => {
    const styles = emptyStyles(1)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [
          rule({ priority: 1, stopIfTrue: true, type: 'containsBlanks' }),
          rule({ priority: 2, differentialFormatId: 1 })
        ],
        differentialFormats: [PINK_FILL, GREEN_FILL]
      })
    )

    expect(styles[0]?.[0]?.backgroundColor).toBe('#c6efce')
  })

  it('re-measures a rule ink against the fill that survives the merge', () => {
    const styles: (XlsxCellStyle | undefined)[][] = [
      [{ backgroundColor: '#1f4e78', textColor: '#ffffff' }]
    ]

    applyXlsxConditionalStyles(
      styles,
      input({ rules: [rule()], differentialFormats: [{ textColor: '#000000' }] })
    )

    expect(styles[0]?.[0]).toEqual({ backgroundColor: '#1f4e78', textColor: '#ffffff' })
  })

  it('compares a cellIs rule against the raw number keyed by row and column', () => {
    const rows = filledRows(27, 2, '')
    rows[26]![1] = '-50 €'
    const styles = emptyStyles(27)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [
          rule({
            type: 'cellIs',
            operator: 'lessThan',
            formulas: ['0'],
            cells: [{ rowIndex: 26, columnIndex: 1 }]
          })
        ],
        rows,
        numericValues: new Map([['26:1', -50]])
      })
    )

    expect(styles[26]?.[1]).toEqual(PINK_FILL)
  })

  it('leaves a cellIs rule unmatched when no raw number was collected', () => {
    const rows = filledRows(27, 2, '')
    rows[26]![1] = '-50 €'
    const styles = emptyStyles(27)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [
          rule({
            type: 'cellIs',
            operator: 'lessThan',
            formulas: ['0'],
            cells: [{ rowIndex: 26, columnIndex: 1 }]
          })
        ],
        rows
      })
    )

    expect(styles[26]?.[1]).toBeUndefined()
  })

  it('skips a row the sheet never wrote instead of throwing', () => {
    const rows = [['a'], undefined, ['c']] as unknown as readonly (readonly string[])[]
    const styles = emptyStyles(3)

    expect(() => {
      applyXlsxConditionalStyles(
        styles,
        input({
          rules: [
            rule({
              cells: [
                { rowIndex: 0, columnIndex: 0 },
                { rowIndex: 1, columnIndex: 0 },
                { rowIndex: 2, columnIndex: 0 }
              ]
            })
          ],
          rows
        })
      )
    }).not.toThrow()
    expect(styles[1]).toEqual([])
  })

  it('never grows the styles past the rows the sheet actually has', () => {
    // Why: a rule can cover a whole column, and phantom style rows would render
    // behind the grid.
    const rows = filledRows(3, 1, '')
    const styles = emptyStyles(3)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [
          rule({ type: 'containsBlanks', cells: expandXlsxCellRangeList('A1:A100', 200_000) })
        ],
        rows
      })
    )

    expect(styles.length).toBeLessThanOrEqual(rows.length)
  })

  it('paints every range of a multi-range rule and nothing between them', () => {
    const rows = filledRows(44, 8)
    const styles = emptyStyles(44)

    applyXlsxConditionalStyles(
      styles,
      input({
        rules: [rule({ cells: expandXlsxCellRangeList('B27:C44 H27:H44', 200_000) })],
        rows
      })
    )

    expect(styles[26]?.[1]).toEqual(PINK_FILL)
    expect(styles[26]?.[7]).toEqual(PINK_FILL)
    expect(styles[26]?.[3]).toBeUndefined()
  })

  it('gives the same result when the same rules are applied twice', () => {
    const styles: (XlsxCellStyle | undefined)[][] = [[{ bold: true }]]
    const styleInput = input({ rules: [rule()] })

    applyXlsxConditionalStyles(styles, styleInput)
    const afterFirstPass = structuredClone(styles)
    applyXlsxConditionalStyles(styles, styleInput)

    expect(styles).toEqual(afterFirstPass)
  })
})
