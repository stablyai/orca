// Why: xlsx and xlsm are the same OPC container (zip + SpreadsheetML), so one
// reader covers both. Macros are never evaluated — this is a read-only preview.
export const SPREADSHEET_FILE_MIME_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12'
}

export const SPREADSHEET_FILE_EXTENSIONS = Object.freeze(Object.keys(SPREADSHEET_FILE_MIME_TYPES))

const SPREADSHEET_MIME_TYPES = new Set(Object.values(SPREADSHEET_FILE_MIME_TYPES))

export function isSpreadsheetMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && SPREADSHEET_MIME_TYPES.has(mimeType)
}

// Why: images and PDFs stream their base64 payload straight into an <img> or
// pdf.js surface, so they can afford the 50MB previewable-binary budget. A
// workbook is inflated and parsed into renderer JS objects instead, and sheet
// XML routinely expands 20-50x over the zipped bytes — cap it far lower so a
// stray multi-hundred-MB export cannot take the window down.
export const MAX_PREVIEWABLE_SPREADSHEET_SIZE = 20 * 1024 * 1024

export function resolvePreviewableBinaryByteLimit(
  mimeType: string,
  previewableBinaryLimit: number
): number {
  return isSpreadsheetMimeType(mimeType)
    ? Math.min(MAX_PREVIEWABLE_SPREADSHEET_SIZE, previewableBinaryLimit)
    : previewableBinaryLimit
}
