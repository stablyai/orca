import { useCallback, useMemo, useState } from 'react'
import { detectCsvDelimiter } from './csv-parse'
import { CsvDelimiterPicker, type CsvDelimiterChoice } from './csv-delimiter-picker'
import { CsvGrid } from './CsvGrid'
import { translate } from '@/i18n/i18n'
import { openCsvHttpLink } from './csv-link-routing'
import { parseCsvTextDocument } from './csv-text-document'
import { csvInspectionRows, csvSourceRow, type CsvInspectionSort } from './csv-inspection'
import { useCsvTableEditor } from './useCsvTableEditor'
import { CsvTableToolbar } from './CsvTableToolbar'
import { remapCsvColumnWidths } from './csv-column-width-preferences'
import { useCsvColumnWidths } from './useCsvColumnWidths'
import { buildFileViewPreferenceKey } from '../file-view-preference-storage'

export default function CsvViewer({
  content,
  filePath,
  worktreeId,
  runtimeEnvironmentId,
  preferenceKey,
  onContentChange,
  onSave,
  fileId,
  isDirty,
  onDirtyStateHint
}: {
  content: string
  filePath: string
  worktreeId?: string
  runtimeEnvironmentId?: string | null
  preferenceKey?: string
  fileId?: string
  isDirty?: boolean
  onDirtyStateHint?: (dirty: boolean) => void
  onContentChange?: (content: string) => void
  onSave?: (content: string) => Promise<boolean>
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
        parsed: parseCsvTextDocument(content, delimiter),
        error: null
      }
    } catch (error) {
      return { parsed: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [content, delimiter])
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<CsvInspectionSort | null>(null)
  const storedKey = JSON.stringify([
    preferenceKey ??
      buildFileViewPreferenceKey({
        worktreeId: worktreeId ?? '',
        runtimeEnvironmentId,
        filePath
      }),
    delimiter
  ])
  const { widths: columnWidths, changeWidths } = useCsvColumnWidths(storedKey)
  const document = result.parsed
  const effectiveSort = sort && sort.column < (document?.columnCount ?? 0) ? sort : null
  const inspectionRows = useMemo(
    () => (document ? csvInspectionRows(document.rows, filter, effectiveSort) : null),
    [document, filter, effectiveSort]
  )
  const editor = useCsvTableEditor({
    document,
    fileId,
    isDirty,
    onDirtyStateHint,
    inspectionRows,
    onContentChange,
    onSave,
    onStructureChange: (mutation) => {
      if (delimiterChoice === 'auto') {
        setDelimiterChoice(delimiter === ',' ? 'comma' : delimiter === ';' ? 'semicolon' : 'tab')
      }
      const widths = remapCsvColumnWidths(columnWidths, document?.columnCount ?? 0, mutation)
      if (widths !== columnWidths) {
        changeWidths(widths)
      }
      if (
        mutation.kind === 'delete-columns' ||
        mutation.kind === 'insert-column' ||
        mutation.kind === 'move-column'
      ) {
        setSort(null)
      }
    }
  })
  const header = document?.rows[0] ?? []
  const rowCount = inspectionRows?.length ?? Math.max(0, (document?.rows.length ?? 0) - 1)
  const sample = useMemo(() => document?.rows.slice(1, 201) ?? [], [document])
  const getRow = useCallback(
    (index: number) => document?.rows[csvSourceRow(index + 1, inspectionRows)],
    [document, inspectionRows]
  )
  return (
    <div ref={editor.setRootRef} className="flex h-full min-h-0 flex-col">
      {onContentChange && (
        <CsvTableToolbar
          selection={editor.selection}
          getSelectedRows={editor.selectedRows}
          sourceRow={csvSourceRow(editor.selection?.focus.row ?? 0, inspectionRows)}
          sourceRowCount={document?.rows.length ?? 0}
          columnCount={document?.columnCount ?? 0}
          filter={filter}
          sort={effectiveSort}
          saving={editor.saving}
          canEdit={!result.error}
          canSave={Boolean(onSave)}
          onFilter={(next) => {
            if (editor.interaction?.commit() !== false) {
              setFilter(next)
            }
          }}
          onSort={(next) => {
            if (editor.interaction?.commit() !== false) {
              setSort(next)
            }
          }}
          onApply={editor.apply}
          onEdit={() =>
            editor.edit(editor.selection?.focus.row ?? 0, editor.selection?.focus.column ?? 0)
          }
          onSave={() => void editor.save()}
          onCopy={() => void editor.copy()}
          onPaste={() => void editor.paste()}
        />
      )}
      {editor.error && (
        <div role="alert" className="border-b border-border px-3 py-2 text-sm text-destructive">
          {editor.error}
        </div>
      )}
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
          columnCount={result.parsed.columnCount}
          interaction={editor.interaction}
          columnWidths={columnWidths}
          onColumnWidthsChange={changeWidths}
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
        columnCount={result.parsed?.columnCount ?? 0}
        delimiterChoice={delimiterChoice}
        detectedDelimiter={detectedDelimiter}
        onDelimiterChange={(next) => {
          if (editor.interaction?.commit() !== false) {
            setDelimiterChoice(next)
          }
        }}
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
