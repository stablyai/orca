import { CSV_PAGED_PREVIEW_BYTES } from './csv-file-limits'
import { CsvPreviewError } from './csv-preview-error'

export function assertCsvTableEditBytes(bytes: number): void {
  if (bytes >= CSV_PAGED_PREVIEW_BYTES) {
    throw new CsvPreviewError('table-edit-budget')
  }
}
