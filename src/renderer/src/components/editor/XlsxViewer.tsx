import React, { useEffect, useMemo, useState } from 'react'
import { decodeBase64ToBytes } from '@/lib/base64-bytes'
import { cn } from '@/lib/utils'
import { SpreadsheetGrid } from './SpreadsheetGrid'
import { xlsxColumnLettersFromIndex } from './xlsx-cell-reference'
import { MAX_XLSX_SHEET_ROWS, parseXlsxWorkbook, type XlsxWorkbook } from './xlsx-workbook'
import { getIntlLocale, translate } from '@/i18n/i18n'

type XlsxViewerProps = {
  /** Base64 workbook bytes, as delivered by the previewable-binary read path. */
  content: string
  filePath: string
}

type WorkbookLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; workbook: XlsxWorkbook }

// Why: an .xlsx is a zip of XML parts, so it cannot be shown by the text editor
// and has no useful image representation either. This viewer inflates and parses
// it into a read-only sheet grid — the same surface CsvViewer renders — with one
// tab per worksheet. Values are shown as stored; only date-formatted numbers are
// interpreted, because a bare date serial is meaningless to a reader.
export default function XlsxViewer({ content, filePath }: XlsxViewerProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<WorkbookLoadState>({ status: 'loading' })
  const [sheetSelection, setSheetSelection] = useState({ filePath, index: 0 })

  const locale = getIntlLocale()

  useEffect(() => {
    let cancelled = false
    setLoadState({ status: 'loading' })
    // Why: decoding and inflating a multi-MB workbook is the expensive part, so
    // it runs off the render pass and its result is dropped if the tab moved on.
    Promise.resolve()
      .then(() => parseXlsxWorkbook(decodeBase64ToBytes(content), { locale }))
      .then((workbook) => {
        if (!cancelled) {
          setLoadState({ status: 'ready', workbook })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to read this workbook'
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [content, locale])

  const sheets = loadState.status === 'ready' ? loadState.workbook.sheets : []
  // Why: derive the active tab instead of resetting it in an Effect — opening a
  // different file must start on its first sheet without a stale-tab repaint.
  const activeSheetIndex =
    sheetSelection.filePath === filePath && sheetSelection.index < sheets.length
      ? sheetSelection.index
      : 0
  const activeSheet = sheets[activeSheetIndex]
  const columnHeader = useMemo(
    () =>
      Array.from({ length: activeSheet?.maxColumns ?? 0 }, (_, columnIndex) =>
        xlsxColumnLettersFromIndex(columnIndex)
      ),
    [activeSheet?.maxColumns]
  )

  if (loadState.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('auto.components.editor.XlsxViewer.4688c4c466', 'Loading workbook...')}
      </div>
    )
  }

  if (loadState.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate('auto.components.editor.XlsxViewer.16c54c41e5', 'Unable to render workbook')}
        </div>
        <div className="max-w-xl break-words text-xs text-muted-foreground">
          {loadState.message}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {activeSheet && activeSheet.rows.length > 0 ? (
        <SpreadsheetGrid
          key={`${filePath}:${activeSheetIndex}`}
          header={columnHeader}
          rows={activeSheet.rows}
          columnCount={activeSheet.maxColumns}
          cellStyles={activeSheet.styles}
          declaredColumnWidths={activeSheet.columnWidths}
          declaredRowHeights={activeSheet.rowHeights}
          mergedRanges={activeSheet.mergedRanges}
          drawings={activeSheet.drawings}
          headerAlignment="center"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          {translate('auto.components.editor.XlsxViewer.2952ec35f8', 'Empty sheet')}
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-spreadsheet-gridline-strong bg-spreadsheet-header px-3 py-1 text-xs text-spreadsheet-header-foreground">
        <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-editor">
          {sheets.map((sheet, index) => (
            <button
              key={`${index}:${sheet.name}`}
              type="button"
              role="tab"
              aria-selected={index === activeSheetIndex}
              className={cn(
                'flex-shrink-0 rounded-t px-3 py-0.5 hover:bg-spreadsheet-row-hover',
                index === activeSheetIndex &&
                  'bg-spreadsheet-surface font-medium text-spreadsheet-foreground shadow-xs',
                sheet.hidden && 'italic opacity-70'
              )}
              onClick={() => setSheetSelection({ filePath, index })}
              title={
                sheet.hidden
                  ? translate('auto.components.editor.XlsxViewer.aaf26ba2b6', '{{name}} (hidden)', {
                      name: sheet.name
                    })
                  : sheet.name
              }
            >
              {sheet.name}
            </button>
          ))}
        </div>
        {activeSheet && (
          <>
            <span className="flex-shrink-0">
              {translate('auto.components.editor.XlsxViewer.cb88b1b447', '{{rowCount}} rows', {
                rowCount: activeSheet.rows.length.toLocaleString(getIntlLocale())
              })}
            </span>
            <span className="flex-shrink-0">
              {translate(
                'auto.components.editor.XlsxViewer.2ce5b9eecb',
                '{{columnCount}} columns',
                {
                  columnCount: activeSheet.maxColumns
                }
              )}
            </span>
            {activeSheet.truncated && (
              <span className="flex-shrink-0 text-destructive">
                {translate(
                  'auto.components.editor.XlsxViewer.2c8df21237',
                  'truncated at {{limit}} rows',
                  { limit: MAX_XLSX_SHEET_ROWS.toLocaleString(getIntlLocale()) }
                )}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
