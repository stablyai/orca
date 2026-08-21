import { IMAGE_FILE_MIME_TYPES } from './image-file-extensions'

// Why: every read path (local IPC, SSH relay, runtime host) must agree on which
// extensions may be sent as base64, or remote workspace previews silently fall
// back to "Binary file — cannot display". Keep this as the single source.
export const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  ...IMAGE_FILE_MIME_TYPES,
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}
