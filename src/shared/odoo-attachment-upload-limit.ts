// Chatter attachment uploads travel as base64 JSON over the same RPC channel
// used for SSH/remote runtimes; an unbounded payload can stall or blow past
// that transport's practical limits, so uploads are capped client-side before
// the call is made rather than left to fail deep inside the RPC pipe.
export const ODOO_ATTACHMENT_UPLOAD_MAX_BYTES = 15 * 1024 * 1024

/** Files the chatter composer accepts on one comment. */
export const MAX_ODOO_ATTACHMENT_COUNT = 10

/** Longest base64 string that can still decode to within the byte cap. */
export const ODOO_ATTACHMENT_UPLOAD_MAX_BASE64_LENGTH =
  Math.ceil(ODOO_ATTACHMENT_UPLOAD_MAX_BYTES / 3) * 4

/** Decoded byte length of a base64 payload (without the `data:` prefix). */
export function base64PayloadByteLength(base64: string): number {
  if (!base64) {
    return 0
  }
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

export function sumOdooAttachmentUploadBytes(files: readonly { data: string }[]): number {
  return files.reduce((total, file) => total + base64PayloadByteLength(file.data), 0)
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Returns an explanatory error when the combined upload exceeds the cap, or null when within bounds. */
export function describeOdooAttachmentUploadOverLimit(
  files: readonly { data: string }[],
  maxBytes: number = ODOO_ATTACHMENT_UPLOAD_MAX_BYTES
): string | null {
  const totalBytes = sumOdooAttachmentUploadBytes(files)
  if (totalBytes <= maxBytes) {
    return null
  }
  return `Attachments total ${formatMebibytes(totalBytes)}, exceeding the ${formatMebibytes(maxBytes)} upload limit.`
}
