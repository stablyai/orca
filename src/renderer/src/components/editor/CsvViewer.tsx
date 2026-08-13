import React, { useMemo } from 'react'
import { detectCsvDelimiter, parseCsv } from './csv-parse'
import { SpreadsheetGrid } from './SpreadsheetGrid'
import { translate } from '@/i18n/i18n'

type CsvViewerProps = {
  content: string
  filePath: string
}

// Why: CsvViewer is the table counterpart to source-mode Monaco for .csv/.tsv
// files. The grid itself lives in SpreadsheetGrid, shared with the workbook
// viewer; this module owns delimiter sniffing, parsing and the row/column count.
export default function CsvViewer({ content, filePath }: CsvViewerProps): React.JSX.Element {
  const parsed = useMemo(() => {
    const delimiter = detectCsvDelimiter(filePath, content)
    return parseCsv(content, delimiter)
  }, [content, filePath])

  // Why: memoize the header/body split so their references stay stable across
  // renders that don't change content. A top-level rest-destructure would slice
  // the full rows array (100k+ on large files) on every render and produce a new
  // `bodyRows` reference, invalidating the grid's column-sizing memo.
  const { headerRow, bodyRows } = useMemo(() => {
    if (parsed.rows.length === 0) {
      return { headerRow: [] as string[], bodyRows: [] as string[][] }
    }
    const [head, ...rest] = parsed.rows
    return { headerRow: head ?? [], bodyRows: rest }
  }, [parsed])

  if (parsed.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('auto.components.editor.CsvViewer.a233d55b77', 'Empty file')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SpreadsheetGrid header={headerRow} rows={bodyRows} columnCount={parsed.maxColumns} />
      <div className="flex items-center gap-4 border-t border-spreadsheet-gridline-strong bg-spreadsheet-header px-3 py-1 text-xs text-spreadsheet-header-foreground">
        <span>
          {bodyRows.length.toLocaleString()}{' '}
          {translate('auto.components.editor.CsvViewer.ac31d2cd60', 'rows')}
        </span>
        <span>
          {parsed.maxColumns} {translate('auto.components.editor.CsvViewer.eedd0d37a7', 'columns')}
        </span>
      </div>
    </div>
  )
}
