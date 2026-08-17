import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from './remote-runtime-memory-limits'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'

// Why: reserve fixed reply fields and future additive metadata; the echoed request id is charged
// separately because the wire contract permits arbitrary strings.
const OUTBOUND_ENVELOPE_RESERVE_BYTES = 4 * 1024
const MAX_JSON_STRING_ESCAPE_EXPANSION = 6
type CachedResultBytes = {
  skeleton: string
  stringFields: readonly { name: string; value: string }[]
  rawStringBytes: number
  byteLength?: number
}
const cachedResultBytes = new WeakMap<object, CachedResultBytes>()

/** Ceiling for content in one RPC reply before charging its request id. */
export const REMOTE_RPC_MAX_CONTENT_BYTES =
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - OUTBOUND_ENVELOPE_RESERVE_BYTES

/** Content budget after charging the JSON-encoded request id echoed by the reply. */
export function remoteRpcContentBudget(requestId: string): number {
  const requestIdBytes = Buffer.byteLength(JSON.stringify(requestId), 'utf8')
  return Math.max(0, REMOTE_RPC_MAX_CONTENT_BYTES - requestIdBytes)
}

function jsonStringContentBytes(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c) {
      bytes += 2
    } else if (code < 0x20) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
    } else if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** Whether a complete RPC result exceeds its request-scoped content budget. */
export function remoteRpcResultExceedsContentBudget(
  result: unknown,
  maxBytes: number,
  largeStringFields: readonly string[] = []
): boolean {
  const stringFields: { name: string; value: string }[] = []
  let measuredResult = result
  if (result !== null && typeof result === 'object' && largeStringFields.length > 0) {
    const skeleton = { ...(result as Record<string, unknown>) }
    for (const field of largeStringFields) {
      const value = skeleton[field]
      if (typeof value === 'string') {
        stringFields.push({ name: field, value })
        skeleton[field] = ''
      }
    }
    measuredResult = skeleton
  }

  let skeletonBytes: number
  let serializedSkeleton: string
  try {
    const measurement = stringifyJsonWithinByteLimit(measuredResult, maxBytes)
    skeletonBytes = measurement.byteLength
    serializedSkeleton = measurement.serialized
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      return true
    }
    throw error
  }

  let rawBytes: number | undefined
  if (result !== null && typeof result === 'object') {
    const cached = cachedResultBytes.get(result)
    if (
      cached?.skeleton === serializedSkeleton &&
      cached.stringFields.length === stringFields.length &&
      cached.stringFields.every(
        (field, index) =>
          field.name === stringFields[index]?.name && field.value === stringFields[index]?.value
      )
    ) {
      if (cached.byteLength !== undefined) {
        return cached.byteLength > maxBytes
      }
      const remainingBytes = maxBytes - skeletonBytes
      if (cached.rawStringBytes * MAX_JSON_STRING_ESCAPE_EXPANSION <= remainingBytes) {
        return false
      }
      if (cached.rawStringBytes > remainingBytes) {
        return true
      }
      rawBytes = cached.rawStringBytes
    }
  }

  const remainingBytes = maxBytes - skeletonBytes
  if (rawBytes === undefined) {
    rawBytes = 0
    for (const field of stringFields) {
      rawBytes += Buffer.byteLength(field.value, 'utf8')
    }
    if (result !== null && typeof result === 'object') {
      cachedResultBytes.set(result, {
        skeleton: serializedSkeleton,
        stringFields,
        rawStringBytes: rawBytes
      })
    }
  }
  if (rawBytes * MAX_JSON_STRING_ESCAPE_EXPANSION <= remainingBytes) {
    return false
  }
  if (rawBytes > remainingBytes) {
    return true
  }

  let encodedBytes = 0
  for (const field of stringFields) {
    encodedBytes += jsonStringContentBytes(field.value)
  }
  if (result !== null && typeof result === 'object') {
    cachedResultBytes.set(result, {
      skeleton: serializedSkeleton,
      stringFields,
      rawStringBytes: rawBytes,
      byteLength: skeletonBytes + encodedBytes
    })
  }
  return encodedBytes > remainingBytes
}
