import { pickReadableCellTextColor } from './spreadsheet-cell-contrast'
import type { XlsxCellStyle } from './xlsx-cell-styles'
import {
  evaluateXlsxConditionalRule,
  type XlsxConditionalRule
} from './xlsx-conditional-formatting'
import type { XlsxDifferentialFormat } from './xlsx-differential-formats'

export type XlsxConditionalStyleInput = {
  rules: readonly XlsxConditionalRule[]
  differentialFormats: readonly XlsxDifferentialFormat[]
  rows: readonly (readonly string[])[]
  /** Raw numeric values keyed `row:column`, for the comparisons that need them. */
  numericValues: ReadonlyMap<string, number>
}

/**
 * Paints the rules that hold over a sheet's own cell styles.
 *
 * Mutates `styles` in place, growing it where a rule reaches a row or cell that
 * carried no style of its own — a workbook can highlight a cell conditionally
 * without ever styling it directly.
 */
export function applyXlsxConditionalStyles(
  styles: (XlsxCellStyle | undefined)[][],
  input: XlsxConditionalStyleInput
): void {
  // Why: lower priority numbers are applied first, and once a matching rule says
  // `stopIfTrue` no later rule may touch that cell.
  const stopped = new Set<string>()

  for (const rule of input.rules) {
    const differentialFormat = input.differentialFormats[rule.differentialFormatId]
    if (differentialFormat === undefined) {
      continue
    }
    // Why: a rule whose format changes nothing the viewer renders still counts for
    // `stopIfTrue`. Authors use exactly that to hold later rules off a range, so
    // skipping it outright would paint cells Excel leaves alone.
    const paints = !isEmptyFormat(differentialFormat)
    for (const cell of rule.cells) {
      const key = `${cell.rowIndex}:${cell.columnIndex}`
      if (stopped.has(key)) {
        continue
      }
      const row = input.rows[cell.rowIndex]
      // Why: a rule may cover a range that runs past the sheet's own data. Those
      // cells are never rendered, and growing `styles` to reach them would leave
      // phantom rows behind the grid.
      if (row === undefined) {
        continue
      }
      const text = row[cell.columnIndex] ?? ''
      const numeric = input.numericValues.get(key)
      if (
        !evaluateXlsxConditionalRule(rule, numeric === undefined ? { text } : { text, numeric })
      ) {
        continue
      }
      if (paints) {
        const styleRow = (styles[cell.rowIndex] ??= [])
        styleRow[cell.columnIndex] = mergeDifferentialFormat(
          styleRow[cell.columnIndex],
          differentialFormat
        )
      }
      if (rule.stopIfTrue) {
        stopped.add(key)
      }
    }
  }
}

function mergeDifferentialFormat(
  base: XlsxCellStyle | undefined,
  differentialFormat: XlsxDifferentialFormat
): XlsxCellStyle {
  const merged: XlsxCellStyle = { ...base, ...differentialFormat }
  // Why: the rule may recolour the text without touching the fill, leaving the
  // author's colour over a background it was never checked against. Re-measure
  // against whichever fill actually survives the merge.
  if (differentialFormat.backgroundColor === undefined && merged.backgroundColor !== undefined) {
    merged.textColor = pickReadableCellTextColor(merged.backgroundColor, merged.textColor, {
      bold: merged.bold
    })
  }
  return merged
}

function isEmptyFormat(format: XlsxDifferentialFormat): boolean {
  return Object.keys(format).length === 0
}
