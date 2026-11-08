import { translate } from '@/i18n/i18n'
import { CsvPreviewError, type CsvPreviewErrorCode } from './csv-preview-error'

export function formatCsvPreviewError(error: unknown): string {
  if (error instanceof CsvPreviewError) {
    return translateCsvPreviewErrorCode(error.code)
  }
  return error instanceof Error ? error.message : String(error)
}

function translateCsvPreviewErrorCode(code: CsvPreviewErrorCode): string {
  switch (code) {
    case 'too-many-cells':
      return translate('csv.error.tooManyCells', 'CSV contains too many cells to preview safely.')
    case 'record-too-large':
      return translate('csv.error.recordTooLarge', 'CSV record is too large to preview safely.')
    case 'too-many-pages':
      return translate('csv.error.tooManyPages', 'CSV has too many pages to preview safely.')
    case 'preview-record-limit':
      return translate('csv.error.previewRecordLimit', 'CSV record exceeds the 1 MB preview limit.')
    case 'binary-data':
      return translate('csv.error.binaryData', 'This file contains binary data.')
    case 'preview-column-limit':
      return translate(
        'csv.error.previewColumnLimit',
        'CSV exceeds the 4,096 column preview limit.'
      )
    case 'changed-on-disk':
      return translate(
        'csv.error.changedOnDisk',
        'CSV changed on disk. Reload the file to refresh the preview.'
      )
    case 'page-boundary-mismatch':
      return translate(
        'csv.error.pageBoundaryMismatch',
        'CSV page boundary mismatch. Reload the preview.'
      )
    case 'canceled':
      return translate('csv.error.canceled', 'CSV preview was canceled')
    case 'worker-failed':
      return translate(
        'csv.error.workerFailed',
        'CSV preview worker failed. Reload the file to retry.'
      )
    case 'worker-unreadable-response':
      return translate(
        'csv.error.workerUnreadableResponse',
        'CSV preview worker returned an unreadable response.'
      )
    case 'cell-missing':
      return translate('csv.error.cellMissing', 'The selected CSV row or column no longer exists.')
    case 'row-missing':
      return translate('csv.error.rowMissing', 'The selected CSV row no longer exists.')
    case 'column-limit':
      return translate('csv.error.columnLimit', 'CSV exceeds the 4,096 column limit.')
    case 'record-limit':
      return translate('csv.error.recordLimit', 'CSV record exceeds the 1 MB limit.')
    case 'table-edit-budget':
      return translate(
        'csv.error.tableEditBudget',
        'Table edits must stay below 1 MiB. Use Source for larger changes.'
      )
    case 'edit-conflict':
      return translate(
        'csv.error.editConflict',
        'CSV changed while this cell was being edited. Cancel and try again.'
      )
    case 'save-failed':
      return translate(
        'csv.error.saveFailed',
        'CSV could not be saved. Your edits remain in the draft.'
      )
    case 'paste-conflict':
      return translate('csv.error.pasteConflict', 'CSV changed before paste completed. Try again.')
    case 'copy-too-many-cells':
      return translate('csv.error.copyTooManyCells', 'Select fewer cells to copy at once.')
    case 'copy-too-large':
      return translate('csv.error.copyTooLarge', 'Selected cells are too large to copy safely.')
    case 'paste-exceeds-table':
      return translate(
        'csv.error.pasteExceedsTable',
        'Paste exceeds the table. Add rows or columns first.'
      )
    case 'paste-too-many-cells':
      return translate('csv.error.pasteTooManyCells', 'Select fewer cells to paste at once.')
  }
}
