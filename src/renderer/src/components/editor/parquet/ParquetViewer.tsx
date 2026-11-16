import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeFileReadArgs } from '@/runtime/files/runtime-file-client-types'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { CsvFooter } from '../csv/CsvViewer'
import { CsvGrid } from '../csv/grid/CsvGrid'
import { useCsvColumnWidths } from '../csv/grid/columns/useCsvColumnWidths'
import { openCsvHttpLink } from '../csv/csv-link-routing'
import { EditorFileLoadErrorView } from '../loading/EditorFileLoadErrorView'
import { buildFileViewPreferenceKey } from '../view-mode/file-view-preference-storage'
import { useParquetPreview } from './useParquetPreview'

export default function ParquetViewer({
  source,
  byteSize,
  preferenceKey,
  onReload
}: {
  source: RuntimeFileReadArgs
  byteSize?: number
  preferenceKey?: string
  onReload: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const preview = useParquetPreview(source, byteSize)
  const { widths, changeWidths } = useCsvColumnWidths(
    JSON.stringify([
      preferenceKey ??
        buildFileViewPreferenceKey({
          worktreeId: source.worktreeId ?? '',
          runtimeEnvironmentId: runtimeTargetEnvironmentId(source.target),
          externalSshTargetId: source.connectionId,
          filePath: source.filePath
        }),
      'parquet'
    ])
  )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-1 text-xs text-muted-foreground">
        {t('parquet.readOnlyPreview', 'Parquet preview · Read-only')}
      </div>
      {preview.error !== null ? (
        <EditorFileLoadErrorView
          message={preview.error instanceof Error ? preview.error.message : String(preview.error)}
          onRetry={onReload}
        />
      ) : preview.ready ? (
        <CsvGrid
          header={preview.header}
          columnWidths={widths}
          onColumnWidthsChange={changeWidths}
          rowCount={preview.rowCount}
          columnCount={preview.header.length}
          sampleRows={preview.sample}
          getRow={preview.getRow}
          onVisibleRows={preview.onVisibleRows}
          onOpenUrl={(url, event) =>
            openCsvHttpLink(url, event, {
              filePath: source.filePath,
              worktreeId: source.worktreeId,
              runtimeEnvironmentId: runtimeTargetEnvironmentId(source.target),
              connectionId: source.connectionId ?? null
            })
          }
        />
      ) : (
        <div
          role="status"
          className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          {t('parquet.loading', 'Reading Parquet file…')}
        </div>
      )}
      <CsvFooter rowCount={preview.rowCount} columnCount={preview.header.length} />
    </div>
  )
}
