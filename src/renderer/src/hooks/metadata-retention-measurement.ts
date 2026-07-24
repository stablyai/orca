import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

const MAX_METADATA_VALUE_DEPTH = 64
const MAX_METADATA_ERROR_NAME_BYTES = 256

export function measureMetadataValueBytes(value: unknown, maxBytes: number): number | null {
  let retainedBytes = 0
  const visited = new WeakSet<object>()
  const addBytes = (bytes: number): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - retainedBytes) {
      return false
    }
    retainedBytes += bytes
    return true
  }
  const visit = (candidate: unknown, depth: number): boolean => {
    if (candidate === null || candidate === undefined) {
      return addBytes(4)
    }
    if (typeof candidate === 'string') {
      const measured = measureUtf8ByteLength(candidate, {
        stopAfterBytes: maxBytes - retainedBytes
      })
      return !measured.exceededLimit && addBytes(measured.byteLength)
    }
    if (typeof candidate === 'number' || typeof candidate === 'bigint') {
      return addBytes(8)
    }
    if (typeof candidate === 'boolean') {
      return addBytes(4)
    }
    if (typeof candidate !== 'object' || depth > MAX_METADATA_VALUE_DEPTH) {
      return false
    }
    if (visited.has(candidate)) {
      return true
    }
    visited.add(candidate)
    if (candidate instanceof ArrayBuffer) {
      return addBytes(candidate.byteLength)
    }
    if (ArrayBuffer.isView(candidate)) {
      return addBytes(candidate.byteLength)
    }
    if (typeof Blob !== 'undefined' && candidate instanceof Blob) {
      return addBytes(candidate.size)
    }
    if (!addBytes(32)) {
      return false
    }
    if (Array.isArray(candidate) && !addBytes(candidate.length * 8)) {
      return false
    }
    if (candidate instanceof Map) {
      if (!addBytes(candidate.size * 16)) {
        return false
      }
      for (const [key, item] of candidate) {
        if (!visit(key, depth + 1) || !visit(item, depth + 1)) {
          return false
        }
      }
      return true
    }
    if (candidate instanceof Set) {
      if (!addBytes(candidate.size * 8)) {
        return false
      }
      for (const item of candidate) {
        if (!visit(item, depth + 1)) {
          return false
        }
      }
      return true
    }
    for (const key in candidate) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
        continue
      }
      const keyMeasurement = measureUtf8ByteLength(key, {
        stopAfterBytes: maxBytes - retainedBytes
      })
      if (
        keyMeasurement.exceededLimit ||
        !addBytes(keyMeasurement.byteLength) ||
        !addBytes(16) ||
        !visit((candidate as Record<string, unknown>)[key], depth + 1)
      ) {
        return false
      }
    }
    return true
  }

  try {
    return visit(value, 0) ? retainedBytes : null
  } catch {
    return null
  }
}

function takeUtf8Prefix(value: string, maxBytes: number): { text: string; bytes: number } {
  let bytes = 0
  let end = 0
  while (end < value.length) {
    const codePoint = value.codePointAt(end) ?? 0
    const codePointText = String.fromCodePoint(codePoint)
    const codePointBytes = measureUtf8ByteLength(codePointText).byteLength
    if (bytes + codePointBytes > maxBytes) {
      break
    }
    bytes += codePointBytes
    end += codePoint > 0xffff ? 2 : 1
  }
  return { text: value.slice(0, end), bytes }
}

export function boundedMetadataFailure(
  error: unknown,
  maxSummaryBytes: number
): { error: Error; bytes: number } {
  const rawName = error instanceof Error && error.name ? error.name : 'Error'
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Metadata request failed'
  const name = takeUtf8Prefix(rawName, Math.min(MAX_METADATA_ERROR_NAME_BYTES, maxSummaryBytes))
  const message = takeUtf8Prefix(rawMessage, Math.max(0, maxSummaryBytes - name.bytes))
  const cachedError = new Error(message.text)
  cachedError.name = name.text || 'Error'
  cachedError.stack = undefined
  return { error: cachedError, bytes: name.bytes + message.bytes }
}
