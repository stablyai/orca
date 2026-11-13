// Why no i18n here: the preview worker throws these, so display sites translate by code.
const CSV_PREVIEW_ERROR_MESSAGES = {
  'too-many-cells': 'CSV contains too many cells to preview safely.',
  'record-too-large': 'CSV record is too large to preview safely.',
  'too-many-pages': 'CSV has too many pages to preview safely.',
  'preview-record-limit': 'CSV record exceeds the 1 MB preview limit.',
  'binary-data': 'This file contains binary data.',
  'preview-column-limit': 'CSV exceeds the 4,096 column preview limit.',
  'changed-on-disk': 'CSV changed on disk. Reload the file to refresh the preview.',
  'page-boundary-mismatch': 'CSV page boundary mismatch. Reload the preview.',
  canceled: 'CSV preview was canceled',
  'worker-failed': 'CSV preview worker failed. Reload the file to retry.',
  'worker-unreadable-response': 'CSV preview worker returned an unreadable response.',
  'cell-missing': 'The selected CSV row or column no longer exists.',
  'row-missing': 'The selected CSV row no longer exists.',
  'column-limit': 'CSV exceeds the 4,096 column limit.',
  'record-limit': 'CSV record exceeds the 1 MB limit.',
  'table-edit-budget': 'Table edits must stay below 1 MiB. Use Source for larger changes.',
  'edit-conflict': 'CSV changed while this cell was being edited. Cancel and try again.',
  'save-failed': 'CSV could not be saved. Your edits remain in the draft.',
  'paste-conflict': 'CSV changed before paste completed. Try again.',
  'copy-too-many-cells': 'Select fewer cells to copy at once.',
  'copy-too-large': 'Selected cells are too large to copy safely.',
  'paste-exceeds-table': 'Paste exceeds the table. Add rows or columns first.',
  'paste-too-many-cells': 'Select fewer cells to paste at once.'
} as const

export type CsvPreviewErrorCode = keyof typeof CSV_PREVIEW_ERROR_MESSAGES

export class CsvPreviewError extends Error {
  readonly code: CsvPreviewErrorCode

  constructor(code: CsvPreviewErrorCode) {
    super(CSV_PREVIEW_ERROR_MESSAGES[code])
    this.name = 'CsvPreviewError'
    this.code = code
  }
}
