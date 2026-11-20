function scannedJsonStringBytes(value: string): number {
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
    } else if (code < 0x20) {
      bytes += 6
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

// Controls without a two-character escape (except ESC, counted below) and surrogates need the per-unit scan.
// oxlint-disable-next-line no-control-regex -- these are the units JSON escapes as \uXXXX.
const SCANNED_UNITS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\ud800-\udfff]/

function occurrences(value: string, unit: string): number {
  let count = 0
  for (let index = value.indexOf(unit); index !== -1; index = value.indexOf(unit, index + 1)) {
    count += 1
  }
  return count
}

export function jsonStringBytes(value: string): number {
  if (value.length < 64 || SCANNED_UNITS.test(value)) {
    return scannedJsonStringBytes(value)
  }
  // Native UTF-8 length plus what each escape adds: one byte for \" \\ \n \r \t, five for \u001b.
  return (
    Buffer.byteLength(value, 'utf8') +
    2 +
    occurrences(value, '"') +
    occurrences(value, '\\') +
    occurrences(value, '\n') +
    occurrences(value, '\r') +
    occurrences(value, '\t') +
    5 * occurrences(value, '\u001b')
  )
}

export function normalizedJsonValue(value: unknown, container: unknown): unknown {
  const tag =
    value !== null && typeof value === 'object' ? Object.prototype.toString.call(value) : ''
  if (tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]') {
    return (value as { valueOf(): unknown }).valueOf()
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return Array.isArray(container) ? null : undefined
  }
  return value
}

export function primitiveJsonBytes(value: unknown): number | null {
  if (value === null) {
    return 4
  }
  if (typeof value === 'string') {
    return jsonStringBytes(value)
  }
  if (typeof value === 'boolean') {
    return value ? 4 : 5
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value).length : 4
  }
  return null
}

export function rawJsonBytes(value: unknown): number | null {
  const isRawJSON = (JSON as { isRawJSON?: (candidate: unknown) => boolean }).isRawJSON
  if (!isRawJSON?.(value)) {
    return null
  }
  const rawJSON = (value as { rawJSON?: unknown }).rawJSON
  return typeof rawJSON === 'string' ? Buffer.byteLength(rawJSON, 'utf8') : null
}

/** Exactly `Buffer.byteLength(JSON.stringify(value), 'utf8')` without building the string. */
export function jsonUtf8ByteLength(value: unknown): number {
  const bytes = jsonPropertyBytes(value, '', false, [])
  if (bytes === null) {
    throw new TypeError('JSON value is not serializable')
  }
  return bytes
}

/** null when JSON.stringify would omit the property. */
function jsonPropertyBytes(
  value: unknown,
  key: string | number,
  inArray: boolean,
  ancestors: object[]
): number | null {
  switch (typeof value) {
    case 'string':
      return jsonStringBytes(value)
    case 'number':
      return Number.isFinite(value) ? String(value).length : 4
    case 'boolean':
      return value ? 4 : 5
    case 'object':
      if (value === null) {
        return 4
      }
      break
    case 'bigint':
      // JSON.stringify throws unless BigInt.prototype.toJSON exists.
      return Buffer.byteLength(JSON.stringify(value), 'utf8')
    default:
      return inArray ? 4 : null
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') {
    const converted = toJSON.call(value, String(key))
    if (converted === null || typeof converted !== 'object') {
      return jsonPropertyBytes(converted, key, inArray, ancestors)
    }
    return jsonObjectBytes(converted, ancestors)
  }
  return jsonObjectBytes(value, ancestors)
}

function jsonObjectBytes(value: object, ancestors: object[]): number | null {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && !Array.isArray(value)) {
    const encoded = rawJsonBytes(value) ?? primitiveJsonBytes(normalizedJsonValue(value, null))
    if (encoded !== null) {
      return encoded
    }
  }
  if (ancestors.includes(value)) {
    throw new TypeError('Converting circular structure to JSON')
  }
  ancestors.push(value)
  let bytes = 2
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      bytes += (index > 0 ? 1 : 0) + (jsonPropertyBytes(value[index], index, true, ancestors) ?? 4)
    }
  } else {
    let emitted = 0
    for (const name of Object.keys(value)) {
      const entry = jsonPropertyBytes(
        (value as Record<string, unknown>)[name],
        name,
        false,
        ancestors
      )
      if (entry !== null) {
        bytes += (emitted > 0 ? 1 : 0) + jsonStringBytes(name) + 1 + entry
        emitted += 1
      }
    }
  }
  ancestors.pop()
  return bytes
}
