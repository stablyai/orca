import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { CsvPreviewError, type CsvPreviewErrorCode } from './csv-preview-error'

export function formatCsvPreviewError(error: unknown, t?: Translate): string {
  if (error instanceof CsvPreviewError) {
    return translateCsvPreviewErrorCode(error.code, t)
  }
  return error instanceof Error ? error.message : String(error)
}

function translateCsvPreviewErrorCode(code: CsvPreviewErrorCode, t: Translate = translate): string {
  switch (code) {
    case 'too-many-cells':
      return t('csv.error.tooManyCells', 'CSV contains too many cells to preview safely.')
    case 'record-too-large':
      return t('csv.error.recordTooLarge', 'CSV record is too large to preview safely.')
    case 'too-many-pages':
      return t('csv.error.tooManyPages', 'CSV has too many pages to preview safely.')
    case 'preview-record-limit':
      return t('csv.error.previewRecordLimit', 'CSV record exceeds the 1 MB preview limit.')
    case 'binary-data':
      return t('csv.error.binaryData', 'This file contains binary data.')
    case 'preview-column-limit':
      return t('csv.error.previewColumnLimit', 'CSV exceeds the 4,096 column preview limit.')
    case 'changed-on-disk':
      return t(
        'csv.error.changedOnDisk',
        'CSV changed on disk. Reload the file to refresh the preview.'
      )
    case 'page-boundary-mismatch':
      return t('csv.error.pageBoundaryMismatch', 'CSV page boundary mismatch. Reload the preview.')
    case 'canceled':
      return t('csv.error.canceled', 'CSV preview was canceled')
    case 'worker-failed':
      return t('csv.error.workerFailed', 'CSV preview worker failed. Reload the file to retry.')
    case 'worker-unreadable-response':
      return t(
        'csv.error.workerUnreadableResponse',
        'CSV preview worker returned an unreadable response.'
      )
    case 'cell-missing':
      return t('csv.error.cellMissing', 'The selected CSV row or column no longer exists.')
    case 'row-missing':
      return t('csv.error.rowMissing', 'The selected CSV row no longer exists.')
    case 'column-limit':
      return t('csv.error.columnLimit', 'CSV exceeds the 4,096 column limit.')
    case 'record-limit':
      return t('csv.error.recordLimit', 'CSV record exceeds the 1 MB limit.')
    case 'table-edit-budget':
      return t(
        'csv.error.tableEditBudget',
        'Table edits must stay below 1 MiB. Use Source for larger changes.'
      )
    case 'edit-conflict':
      return t(
        'csv.error.editConflict',
        'CSV changed while this cell was being edited. Cancel and try again.'
      )
    case 'save-failed':
      return t('csv.error.saveFailed', 'CSV could not be saved. Your edits remain in the draft.')
    case 'paste-conflict':
      return t('csv.error.pasteConflict', 'CSV changed before paste completed. Try again.')
    case 'copy-too-many-cells':
      return t('csv.error.copyTooManyCells', 'Select fewer cells to copy at once.')
    case 'copy-too-large':
      return t('csv.error.copyTooLarge', 'Selected cells are too large to copy safely.')
    case 'paste-exceeds-table':
      return t('csv.error.pasteExceedsTable', 'Paste exceeds the table. Add rows or columns first.')
    case 'paste-too-many-cells':
      return t('csv.error.pasteTooManyCells', 'Select fewer cells to paste at once.')
  }
}
