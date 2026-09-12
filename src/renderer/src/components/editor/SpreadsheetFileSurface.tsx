import React, { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import type {
  SpreadsheetCell,
  SpreadsheetData,
  SpreadsheetRow
} from '../../../../shared/spreadsheet/spreadsheet-data'
import { emptySpreadsheetData } from '../../../../shared/spreadsheet/spreadsheet-data'
import { parseXlsxWorkbook, serializeXlsxWorkbook } from '../../../../shared/spreadsheet/excel-xlsx'
import { detectCsvDelimiter, parseCsv } from './csv-parse'
import { serializeCsvRows } from './csv-serialize'
import { requestEditorFileSave } from './editor-autosave'
import { EditableSheetGrid } from './EditableSpreadsheetGrid'

type SpreadsheetFileSurfaceProps = {
  fileId: string
  filePath: string
  kind: 'csv' | 'xlsx'
  /** CSV text or XLSX base64 (matching FileContent.content). */
  content: string
  readOnly: boolean
  /** CSV keeps the text-path draft so Cmd+S / autosave work unchanged. */
  onCsvChange: (csv: string) => void
  /** XLSX (binary, no text draft) marks the tab dirty through this. */
  onDirty: (dirty: boolean) => void
}

type LoadState =
  | { status: 'loading' }
  /** `delimiter` is the CSV field separator detected from the file content. */
  | { status: 'ready'; data: SpreadsheetData; delimiter: string }
  | { status: 'error'; message: string }

async function loadSpreadsheet(
  kind: 'csv' | 'xlsx',
  content: string,
  filePath: string
): Promise<{ data: SpreadsheetData; delimiter: string }> {
  if (kind === 'xlsx') {
    return { data: await parseXlsxWorkbook(content), delimiter: '' }
  }
  // Why: detect the separator from the real content so edits re-serialize with
  // the same character (a tab-delimited .csv must not be rewritten with commas).
  const delimiter = detectCsvDelimiter(filePath, content)
  const { rows } = parseCsv(content, delimiter)
  if (rows.length === 0) {
    return { data: emptySpreadsheetData(), delimiter }
  }
  return {
    data: {
      worksheets: [{ name: 'Sheet1', rows: rows.map((row) => [...row]) }],
      activeSheetIndex: 0
    },
    delimiter
  }
}

export default function SpreadsheetFileSurface({
  fileId,
  filePath,
  kind,
  content,
  readOnly,
  onCsvChange,
  onDirty
}: SpreadsheetFileSurfaceProps): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(false)
  // Why: an edit during an in-flight XLSX write is not in the saved snapshot, so
  // track a revision and only clear dirty when no edit landed since the save.
  const revisionRef = useRef(0)
  const onDirtyRef = useRef(onDirty)
  onDirtyRef.current = onDirty

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    setActiveSheetIndex(0)
    loadSpreadsheet(kind, content, filePath)
      .then((result) => {
        if (!cancelled) {
          setLoad({ status: 'ready', data: result.data, delimiter: result.delimiter })
        }
      })
      .catch((error) => {
        // Why: surface the real exc.message + exceljs cause in devtools — the
        // user-facing copy intentionally hides the raw parser detail.
        console.error('[spreadsheet] failed to parse', error)
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: translate(
              'auto.components.editor.SpreadsheetFileSurface.readFailed',
              'The file could not be read as a spreadsheet.'
            )
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [kind, content, filePath])

  const data = load.status === 'ready' ? load.data : emptySpreadsheetData()
  /** The separator detected at load time; edits re-serialize with it. */
  const csvDelimiter = load.status === 'ready' ? load.delimiter : ','
  const activeSheet = data.worksheets[
    Math.min(activeSheetIndex, Math.max(data.worksheets.length - 1, 0))
  ] ?? {
    name: 'Sheet1',
    rows: []
  }

  const markDirty = (): void => {
    if (dirtyRef.current) {
      return
    }
    dirtyRef.current = true
    onDirtyRef.current(true)
  }

  const updateCell = (rowIndex: number, colIndex: number, value: string): void => {
    revisionRef.current += 1
    if (kind === 'csv') {
      // Why: keep the text draft in sync so the normal Cmd+S / autosave path
      // (and dirty indicator) apply to CSV exactly as for other text files.
      const rows = buildPatchRows(load, rowIndex, colIndex, value)
      onCsvChange(serializeCsvRows(rows, csvDelimiter))
      return
    }
    markDirty()
    setLoad((prev) => {
      if (prev.status !== 'ready') {
        return prev
      }
      const next = cloneData(prev.data)
      ensureCell(next, activeSheetIndex, rowIndex, colIndex)
      next.worksheets[activeSheetIndex]!.rows[rowIndex]![colIndex] = parseCellValue(value)
      return { status: 'ready', data: next, delimiter: prev.delimiter }
    })
  }

  const handleSave = async (): Promise<void> => {
    if (load.status !== 'ready') {
      return
    }
    // Why: snapshot the revision so an edit that lands during the async write
    // keeps the tab dirty (the saved snapshot does not include it).
    const revisionAtSave = revisionRef.current
    setSaving(true)
    try {
      if (kind === 'csv') {
        const csv = serializeCsvRows(data.worksheets[activeSheetIndex]?.rows ?? [], csvDelimiter)
        onCsvChange(csv)
        await requestEditorFileSave({ fileId, fallbackContent: csv })
      } else {
        const base64 = await serializeXlsxWorkbook(data)
        await requestEditorFileSave({ fileId, fallbackContent: base64, encoding: 'base64' })
      }
      if (revisionRef.current === revisionAtSave) {
        dirtyRef.current = false
        onDirtyRef.current(false)
      }
    } catch {
      toast.error(
        translate(
          'auto.components.editor.SpreadsheetFileSurface.saveFailed',
          'Failed to save the spreadsheet. Please try again.'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  if (load.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('auto.components.editor.EditorContent.b2735221f5', 'Loading...')}
      </div>
    )
  }
  if (load.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <span>{load.message}</span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SpreadsheetToolbar
        kind={kind}
        sheets={data.worksheets}
        activeIndex={activeSheetIndex}
        readonly={readOnly}
        saving={saving}
        onSelectSheet={setActiveSheetIndex}
        onSave={handleSave}
      />
      <div className="min-h-0 flex-1">
        <EditableSheetGrid
          rows={activeSheet.rows}
          readonly={readOnly}
          scrollRef={scrollRef}
          onCellChange={(r, c, v) => updateCell(r, c, v)}
        />
      </div>
    </div>
  )
}

function parseCellValue(raw: string): SpreadsheetCell {
  if (raw === '') {
    return null
  }
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isSafeInteger(n)) {
      return n
    }
  }
  if (/^-?\d*\.\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) {
      return n
    }
  }
  return raw
}

function cloneData(data: SpreadsheetData): SpreadsheetData {
  return {
    worksheets: data.worksheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.map((row) => [...row])
    })),
    activeSheetIndex: data.activeSheetIndex
  }
}

function ensureCell(
  data: SpreadsheetData,
  sheetIndex: number,
  rowIndex: number,
  colIndex: number
): void {
  const sheet = data.worksheets[sheetIndex]!
  while (sheet.rows.length <= rowIndex) {
    sheet.rows.push([])
  }
  while (sheet.rows[rowIndex]!.length <= colIndex) {
    sheet.rows[rowIndex]!.push(null)
  }
}

// Why: CSV serializes on every keystroke, so produce the patched rows directly.
// CSV fields stay raw text — numeric coercion would rewrite identifiers like
// `00123` as `123` and drop trailing zeros on save.
function buildPatchRows(
  load: LoadState,
  rowIndex: number,
  colIndex: number,
  value: string
): SpreadsheetRow[] {
  const data = load.status === 'ready' ? cloneData(load.data) : emptySpreadsheetData()
  ensureCell(data, 0, rowIndex, colIndex)
  data.worksheets[0]!.rows[rowIndex]![colIndex] = value
  return data.worksheets[0]?.rows ?? []
}

function SpreadsheetToolbar({
  kind,
  sheets,
  activeIndex,
  readonly,
  saving,
  onSelectSheet,
  onSave
}: {
  kind: 'csv' | 'xlsx'
  sheets: { name: string }[]
  activeIndex: number
  readonly: boolean
  saving: boolean
  onSelectSheet: (index: number) => void
  onSave: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {sheets.map((sheet, index) => (
          <button
            key={`${index}:${sheet.name}`}
            type="button"
            onClick={() => onSelectSheet(index)}
            className={`shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 ${
              index === activeIndex ? 'bg-accent text-foreground' : ''
            }`}
          >
            {sheet.name}
          </button>
        ))}
      </div>
      {kind === 'xlsx' && !readonly && (
        <button
          type="button"
          disabled={saving}
          onClick={() => void onSave()}
          className="shrink-0 rounded px-2 py-0.5 text-xs text-foreground hover:bg-accent/50 disabled:opacity-50"
        >
          {saving
            ? translate('auto.components.editor.SpreadsheetFileSurface.saving', 'Saving…')
            : translate('auto.components.editor.SpreadsheetFileSurface.save', 'Save')}
        </button>
      )}
    </div>
  )
}
