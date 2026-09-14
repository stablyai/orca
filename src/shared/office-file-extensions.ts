export const OFFICE_DOCUMENT_FILE_MIME_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

export const OFFICE_DOCUMENT_FILE_EXTENSIONS = Object.freeze(
  Object.keys(OFFICE_DOCUMENT_FILE_MIME_TYPES)
)
