import { CSV_PAGED_PREVIEW_BYTES } from './csv-file-limits'

export function assertCsvTableEditBytes(bytes: number): void {
  if (bytes >= CSV_PAGED_PREVIEW_BYTES) {
    throw new Error('Table edits must stay below 1 MiB. Use Source for larger changes.')
  }
}
