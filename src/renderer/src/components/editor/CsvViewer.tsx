import { useCallback, useMemo, useState } from 'react'
import { detectCsvDelimiter, parseCsv } from './csv-parse'
import { CsvDelimiterPicker, type CsvDelimiterChoice } from './csv-delimiter-picker'
import { CsvGrid } from './CsvGrid'
import { translate } from '@/i18n/i18n'
import { CSV_MAX_COLUMNS, CSV_RECORD_BYTES } from './csv-byte-index'
import { openCsvHttpLink } from './csv-link-routing'
import { CSV_PAGED_PREVIEW_BYTES } from './editor-csv-file-content'

export default function CsvViewer({
  content,
  filePath,
  worktreeId,
  runtimeEnvironmentId
}: {
  content: string
  filePath: string
  worktreeId?: string
  runtimeEnvironmentId?: string | null
}): React.JSX.Element {
  const [delimiterChoice, setDelimiterChoice] = useState<CsvDelimiterChoice>('auto')
  const detectedDelimiter = useMemo(
    () => detectCsvDelimiter(filePath, content),
    [filePath, content]
  )
  const delimiter = csvChosenDelimiter(delimiterChoice, detectedDelimiter)
  const result = useMemo(() => {
    try {
      return {
        parsed: parseCsv(content, delimiter, {
          maxCells: CSV_PAGED_PREVIEW_BYTES + 1,
          maxColumns: CSV_MAX_COLUMNS,
          maxRecordLength: CSV_RECORD_BYTES
        }),
        error: null
      }
    } catch (error) {
      return { parsed: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [content, delimiter])
  const header = result.parsed?.rows[0] ?? []
  const rowCount = Math.max(0, (result.parsed?.rows.length ?? 0) - 1)
  const sample = useMemo(() => result.parsed?.rows.slice(1, 201) ?? [], [result.parsed])
  const getRow = useCallback((index: number) => result.parsed?.rows[index + 1], [result.parsed])
  return (
    <div className="flex h-full min-h-0 flex-col">
      {result.error ? (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center px-4 text-sm text-muted-foreground"
        >
          {result.error}
        </div>
      ) : result.parsed?.rows.length ? (
        <CsvGrid
          key={delimiter}
          header={header}
          rowCount={rowCount}
          columnCount={result.parsed.maxColumns}
          sampleRows={sample}
          getRow={getRow}
          onOpenUrl={(url, event) =>
            openCsvHttpLink(url, event, { filePath, worktreeId, runtimeEnvironmentId })
          }
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {translate('auto.components.editor.CsvViewer.a233d55b77', 'Empty file')}
        </div>
      )}
      <CsvFooter
        rowCount={rowCount}
        columnCount={result.parsed?.maxColumns ?? 0}
        delimiterChoice={delimiterChoice}
        detectedDelimiter={detectedDelimiter}
        onDelimiterChange={setDelimiterChoice}
      />
    </div>
  )
}

export function csvChosenDelimiter(choice: CsvDelimiterChoice, detected: string): string {
  return choice === 'auto'
    ? detected
    : choice === 'comma'
      ? ','
      : choice === 'semicolon'
        ? ';'
        : '\t'
}

export function CsvFooter({
  rowCount,
  columnCount,
  delimiterChoice,
  detectedDelimiter,
  onDelimiterChange
}: {
  rowCount: number
  columnCount: number
  delimiterChoice: CsvDelimiterChoice
  detectedDelimiter: string
  onDelimiterChange: (choice: CsvDelimiterChoice) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-border/60 px-3 py-1 text-xs text-muted-foreground">
      <span>
        {rowCount.toLocaleString()}{' '}
        {translate('auto.components.editor.CsvViewer.ac31d2cd60', 'rows')}
      </span>
      <span>
        {columnCount.toLocaleString()}{' '}
        {translate('auto.components.editor.CsvViewer.eedd0d37a7', 'columns')}
      </span>
      <CsvDelimiterPicker
        value={delimiterChoice}
        detectedDelimiter={detectedDelimiter}
        onChange={onDelimiterChange}
      />
    </div>
  )
}
