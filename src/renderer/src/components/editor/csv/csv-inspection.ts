import { uiCollator } from '@/i18n/ui-intl-formatters'

const NUMERIC_COLLATION: Intl.CollatorOptions = { numeric: true }
export type CsvInspectionSort = { column: number; direction: 'ascending' | 'descending' }

export function csvInspectionRows(
  rows: readonly string[][],
  filter: string,
  sort: CsvInspectionSort | null
): number[] | null {
  if (!filter && !sort) {
    return null
  }
  const query = filter.toLocaleLowerCase()
  const result: number[] = []
  for (let row = 1; row < rows.length; row += 1) {
    if (!query || rows[row]!.some((cell) => cell.toLocaleLowerCase().includes(query))) {
      result.push(row)
    }
  }
  if (sort) {
    const collator = uiCollator(NUMERIC_COLLATION)
    const direction = sort.direction === 'ascending' ? 1 : -1
    result.sort(
      (a, b) =>
        direction * collator.compare(rows[a]?.[sort.column] ?? '', rows[b]?.[sort.column] ?? '') ||
        a - b
    )
  }
  return result
}

export function csvSourceRow(viewRow: number, inspectionRows: readonly number[] | null): number {
  return viewRow === 0 ? 0 : inspectionRows ? (inspectionRows[viewRow - 1] ?? -1) : viewRow
}
