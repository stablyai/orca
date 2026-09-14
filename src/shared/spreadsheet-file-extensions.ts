// Why: only the OOXML `.xlsx` container is parsed (exceljs has no BIFF reader),
// so a legacy `.xls` must not be classified as a readable spreadsheet — it would
// open empty and then overwrite the file on save.
export const SPREADSHEET_FILE_MIME_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

export const SPREADSHEET_FILE_EXTENSIONS = Object.freeze(Object.keys(SPREADSHEET_FILE_MIME_TYPES))
