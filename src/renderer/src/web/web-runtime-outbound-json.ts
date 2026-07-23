import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export class WebRuntimeOutboundJsonLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Remote runtime JSON payload exceeds ${maxBytes} bytes`)
    this.name = 'WebRuntimeOutboundJsonLimitError'
  }
}

export type WebRuntimeOutboundJson = {
  byteLength: number
  serialized: string | undefined
}

export function stringifyWebRuntimeOutboundJson(
  value: unknown,
  maxBytes: number
): WebRuntimeOutboundJson {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Remote runtime JSON limit must be a positive safe integer')
  }
  let estimatedBytes = 0
  let root = true
  const emittedMembers = new WeakMap<object, number>()
  const serialized = JSON.stringify(value, function (key, item: unknown) {
    const isRoot = root
    root = false
    const parent = this as object
    const inArray = Array.isArray(parent)
    if (isRoot && isOmittedObjectValue(item)) {
      return item
    }
    if (!isRoot && !inArray && isOmittedObjectValue(item)) {
      return item
    }
    if (!isRoot) {
      const emitted = emittedMembers.get(parent) ?? 0
      estimatedBytes += emitted > 0 ? 1 : 0
      if (!inArray) {
        estimatedBytes += escapedJsonStringBytes(key) + 1
      }
      emittedMembers.set(parent, emitted + 1)
    }
    estimatedBytes +=
      inArray && isOmittedObjectValue(item)
        ? 4
        : jsonValueBytes(item, Math.max(0, maxBytes - estimatedBytes))
    if (estimatedBytes > maxBytes) {
      throw new WebRuntimeOutboundJsonLimitError(maxBytes)
    }
    if (typeof item === 'object' && item !== null) {
      // Why: the same container can appear twice, and each traversal starts with no emitted members.
      emittedMembers.set(item, 0)
    }
    return item
  })
  if (serialized === undefined) {
    return { serialized, byteLength: 0 }
  }
  const measured = measureUtf8ByteLength(serialized, { stopAfterBytes: maxBytes })
  if (measured.exceededLimit) {
    throw new WebRuntimeOutboundJsonLimitError(maxBytes)
  }
  return { serialized, byteLength: measured.byteLength }
}

function isOmittedObjectValue(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

function jsonValueBytes(value: unknown, stopAfterBytes: number): number {
  if (value === null) {
    return 4
  }
  if (typeof value === 'string') {
    return escapedJsonStringBytes(value)
  }
  if (typeof value === 'boolean') {
    return value ? 4 : 5
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value).length : 4
  }
  if (typeof value === 'object' && value !== null) {
    return rawJsonBytes(value, stopAfterBytes) ?? boxedPrimitiveJsonBytes(value) ?? 2
  }
  return 4
}

function rawJsonBytes(value: object, stopAfterBytes: number): number | null {
  const json = JSON as typeof JSON & { isRawJSON?: (candidate: unknown) => boolean }
  if (json.isRawJSON?.(value) !== true) {
    return null
  }
  const rawJson = (value as { rawJSON?: unknown }).rawJSON
  if (typeof rawJson !== 'string') {
    return stopAfterBytes + 1
  }
  return measureUtf8ByteLength(rawJson, { stopAfterBytes }).byteLength
}

function boxedPrimitiveJsonBytes(value: object): number | null {
  try {
    return escapedJsonStringBytes(String.prototype.valueOf.call(value))
  } catch {}
  try {
    const number = Number.prototype.valueOf.call(value)
    return Number.isFinite(number) ? String(number).length : 4
  } catch {}
  try {
    return Boolean.prototype.valueOf.call(value) ? 4 : 5
  } catch {
    return null
  }
}

function escapedJsonStringBytes(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2
    } else if (
      code <= 0x1f ||
      (code >= 0xd800 && code <= 0xdfff && !isSurrogatePair(value, index))
    ) {
      bytes += 6
    } else if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

function isSurrogatePair(value: string, index: number): boolean {
  const code = value.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1)
    return next >= 0xdc00 && next <= 0xdfff
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = value.charCodeAt(index - 1)
    return previous >= 0xd800 && previous <= 0xdbff
  }
  return false
}
