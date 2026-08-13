import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from './remote-runtime-memory-limits'
import type { GitDiffResult } from './types'

// Why: headroom for what an RPC reply wraps around its payload — request id, _meta.runtimeId, result
// keys. Measured overhead is 181 B (text) to 243 B (binary with isImage/mimeType); the rest is
// margin. Every reserved byte is content that transferred before this cap existed, so keep it tight.
const OUTBOUND_ENVELOPE_RESERVE_BYTES = 8 * 1024

/** Ceiling for the content a single RPC reply may carry, so its serialized envelope still fits. */
export const REMOTE_RPC_MAX_CONTENT_BYTES =
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - OUTBOUND_ENVELOPE_RESERVE_BYTES

export const GIT_DIFF_TOO_LARGE_CODE = 'diff_too_large'

// Why: JSON escaping turns one control byte into six (\u00XX), and binary-buffer.ts sniffs only for
// NUL in the first 8 KiB, so control-dense content is classified as text — a raw-byte cap would
// admit it and the serialized reply would then blow the envelope.
const MAX_JSON_ESCAPE_EXPANSION = 6
const JSON_QUOTE_BYTES_PER_SIDE = 2

/** Bytes `JSON.stringify(value)` yields, abandoning the scan once `maxBytes` is passed. */
function jsonStringBytes(value: string, maxBytes: number): number {
  let bytes = JSON_QUOTE_BYTES_PER_SIDE
  for (let index = 0; index < value.length && bytes <= maxBytes; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c) {
      bytes += 2
    } else if (code < 0x20) {
      // \b \t \n \f \r have two-character escapes; the rest expand to \u00XX.
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
    } else if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) {
      bytes += 4
      index += 1
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6 // Lone surrogates are escaped, not encoded (JSON.stringify well-formed output).
    } else {
      bytes += 3
    }
  }
  return bytes
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Whether the diff's content sides exceed `maxBytes` once JSON-encoded. */
export function gitDiffExceedsTransportBudget(result: GitDiffResult, maxBytes: number): boolean {
  // Why: the SSH provider casts a relay payload to GitDiffResult without validating it, so a skewed
  // relay version can omit a side; treat a missing one as empty rather than throwing here.
  const sides = [result.originalContent, result.modifiedContent].filter(
    (side): side is string => typeof side === 'string'
  )
  let rawBytes = 0
  for (const side of sides) {
    rawBytes += Buffer.byteLength(side, 'utf8')
  }
  // Why: escaping never shrinks and never grows past 6x, so both bounds settle the verdict without
  // walking multi-megabyte strings; only the band between them needs the exact count.
  if (rawBytes * MAX_JSON_ESCAPE_EXPANSION + sides.length * JSON_QUOTE_BYTES_PER_SIDE <= maxBytes) {
    return false
  }
  if (rawBytes > maxBytes) {
    return true
  }
  let bytes = 0
  for (const side of sides) {
    bytes += jsonStringBytes(side, maxBytes - bytes)
  }
  return bytes > maxBytes
}

/** `maxBytes === undefined` means uncapped: local and in-process callers keep full fidelity. */
export function assertGitDiffWithinTransportBudget<T extends GitDiffResult>(
  result: T,
  maxBytes: number | undefined
): T {
  if (maxBytes === undefined || !gitDiffExceedsTransportBudget(result, maxBytes)) {
    return result
  }
  throw Object.assign(new Error('This diff is too large to open over a remote connection.'), {
    code: GIT_DIFF_TOO_LARGE_CODE,
    data: { maxBytes }
  })
}
