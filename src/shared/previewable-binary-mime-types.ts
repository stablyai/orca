import { IMAGE_FILE_MIME_TYPES } from './image-file-extensions'

// Why: every read path (local IPC, SSH relay, runtime host) must agree on which
// extensions may be sent as base64, or remote workspace previews silently fall
// back to "Binary file — cannot display". Keep this as the single source.
export const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = Object.freeze({
  ...IMAGE_FILE_MIME_TYPES,
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
})

// Why: base64 inflates the on-the-wire payload 4/3; cap the binary size so a
// single previewable file can't exceed one transport frame regardless of which
// path produced it (local IPC, SSH relay, runtime host). Both consumers must
// import this — never declare a local copy.
export const MAX_PREVIEWABLE_BINARY_BYTES = 50 * 1024 * 1024 // 50 MiB

// Why: relay and SSH host read paths also need a text-file cap. Kept next to
// MAX_PREVIEWABLE_BINARY_BYTES so a future bump happens in one place.
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024 // 10 MiB
