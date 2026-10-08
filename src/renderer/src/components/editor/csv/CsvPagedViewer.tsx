import { useEffect, useState } from 'react'
import { readRuntimeFileRange } from '@/runtime/runtime-file-range-client'
import { translate } from '@/i18n/i18n'
import { detectCsvDelimiter } from './csv-parse'
import { CsvFooter, csvChosenDelimiter } from './CsvViewer'
import { CsvGrid } from './CsvGrid'
import type { CsvFilePreview } from './csv-file-content'
import type { CsvDelimiterChoice } from './csv-delimiter-picker'
import { useCsvPagedPreview } from './useCsvPagedPreview'
import { EditorFileLoadErrorView } from '../EditorFileLoadErrorView'
import { useCsvColumnWidths } from './useCsvColumnWidths'
import { buildFileViewPreferenceKey } from '../file-view-preference-storage'
import { openCsvHttpLink } from './csv-link-routing'

export default function CsvPagedViewer({
  file,
  filePath,
  preferenceKey,
  onReload
}: {
  file: CsvFilePreview
  filePath: string
  preferenceKey?: string
  onReload: () => void
}): React.JSX.Element {
  const [sniff, setSniff] = useState<{ delimiter: string; error: string | null } | null>(null)
  const [choice, setChoice] = useState<CsvDelimiterChoice>('auto')
  useEffect(() => {
    let canceled = false
    setSniff(null)
    void readRuntimeFileRange(file.readArgs, 0, Math.min(file.snapshot.size, 64 * 1024))
      .then((bytes) => {
        if (!canceled) {
          setSniff({
            delimiter: detectCsvDelimiter(filePath, new TextDecoder().decode(bytes)),
            error: null
          })
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setSniff({
            delimiter: ',',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      canceled = true
    }
  }, [file, filePath])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-1 text-xs text-muted-foreground">
        {translate('csv.readOnlyPreview', 'Large file preview · Read-only')}
      </div>
      {sniff?.error ? (
        <EditorFileLoadErrorView message={sniff.error} onRetry={onReload} />
      ) : sniff ? (
        <CsvPagedTable
          key={csvChosenDelimiter(choice, sniff.delimiter)}
          file={file}
          preferenceKey={preferenceKey}
          delimiter={csvChosenDelimiter(choice, sniff.delimiter)}
          choice={choice}
          detected={sniff.delimiter}
          onChange={setChoice}
          onReload={onReload}
        />
      ) : (
        <div role="status" className="p-4 text-sm text-muted-foreground">
          {translate('csv.detectingDelimiter', 'Detecting delimiter…')}
        </div>
      )}
    </div>
  )
}

function CsvPagedTable({
  file,
  preferenceKey,
  delimiter,
  choice,
  detected,
  onChange,
  onReload
}: {
  file: CsvFilePreview
  preferenceKey?: string
  delimiter: string
  choice: CsvDelimiterChoice
  detected: string
  onChange: (choice: CsvDelimiterChoice) => void
  onReload: () => void
}): React.JSX.Element {
  const storedKey = JSON.stringify([
    preferenceKey ??
      buildFileViewPreferenceKey({
        worktreeId: file.readArgs.worktreeId ?? '',
        runtimeEnvironmentId: file.readArgs.settings?.activeRuntimeEnvironmentId,
        externalSshTargetId: file.readArgs.connectionId,
        filePath: file.readArgs.filePath
      }),
    delimiter
  ])
  const { widths, changeWidths } = useCsvColumnWidths(storedKey)
  const preview = useCsvPagedPreview(file, delimiter)
  const rowCount = Math.max(0, (preview.index?.rowCount ?? 0) - 1)
  return (
    <>
      {preview.error ? (
        <EditorFileLoadErrorView message={preview.error} onRetry={onReload} />
      ) : preview.index ? (
        <CsvGrid
          header={preview.header}
          columnWidths={widths}
          onColumnWidthsChange={changeWidths}
          rowCount={rowCount}
          columnCount={preview.index.columnCount}
          sampleRows={preview.sample}
          getRow={preview.getRow}
          onVisibleRows={preview.onVisibleRows}
          onOpenUrl={(url, event) =>
            openCsvHttpLink(url, event, {
              filePath: file.readArgs.filePath,
              worktreeId: file.readArgs.worktreeId,
              runtimeEnvironmentId: file.readArgs.settings?.activeRuntimeEnvironmentId,
              connectionId: file.readArgs.connectionId ?? null
            })
          }
        />
      ) : (
        <div
          role="status"
          className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          {translate('csv.indexProgress', 'Indexing CSV… {{percent}}%', {
            percent: Math.floor((preview.progress / file.snapshot.size) * 100)
          })}
        </div>
      )}
      <CsvFooter
        rowCount={rowCount}
        columnCount={preview.index?.columnCount ?? 0}
        delimiterChoice={choice}
        detectedDelimiter={detected}
        onDelimiterChange={onChange}
      />
    </>
  )
}
