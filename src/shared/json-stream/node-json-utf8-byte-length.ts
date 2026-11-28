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

// Deeper values are rare; JSON.stringify sizes them and reports cycles.
const MAX_WALK_DEPTH = 64

/** Exactly `Buffer.byteLength(JSON.stringify(value), 'utf8')`; plain JSON data is sized without building the string. */
export function jsonUtf8ByteLength(value: unknown): number {
  const bytes = jsonPropertyBytes(value, '', false, 0)
  if (bytes === null) {
    throw new TypeError('JSON value is not serializable')
  }
  return bytes
}

function integerDigits(value: number): number {
  let digits = value < 0 ? 2 : 1
  for (let rest = Math.abs(value); rest >= 10; rest = Math.floor(rest / 10)) {
    digits += 1
  }
  return digits
}

/** Native serialization of one property, so toJSON, boxed values, BigInt and cycles behave exactly as JSON.stringify. */
function serializedPropertyBytes(
  value: unknown,
  key: string | number,
  inArray: boolean
): number | null {
  const name = String(key)
  const serialized = JSON.stringify({ [name]: value })
  if (serialized.length === 2) {
    return inArray ? 4 : null
  }
  return Buffer.byteLength(serialized, 'utf8') - 3 - jsonStringBytes(name)
}

/** null when JSON.stringify would omit the property. */
function jsonPropertyBytes(
  value: unknown,
  key: string | number,
  inArray: boolean,
  depth: number
): number | null {
  switch (typeof value) {
    case 'string':
      return jsonStringBytes(value)
    case 'number':
      if (Number.isSafeInteger(value)) {
        return integerDigits(value)
      }
      return Number.isFinite(value) ? String(value).length : 4
    case 'boolean':
      return value ? 4 : 5
    case 'undefined':
    case 'symbol':
      return inArray ? 4 : null
    case 'object':
      if (value === null) {
        return 4
      }
      break
    default:
      // BigInt, and functions that may carry toJSON.
      return serializedPropertyBytes(value, key, inArray)
  }
  if (depth >= MAX_WALK_DEPTH || typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return serializedPropertyBytes(value, key, inArray)
  }
  if (Array.isArray(value)) {
    const length = value.length
    let bytes = 2
    for (let index = 0; index < length; index += 1) {
      bytes += (index > 0 ? 1 : 0) + (jsonPropertyBytes(value[index], index, true, depth + 1) ?? 4)
    }
    return bytes
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return serializedPropertyBytes(value, key, inArray)
  }
  let bytes = 2
  let emitted = 0
  const record = value as Record<string, unknown>
  for (const name of Object.keys(record)) {
    const entry = jsonPropertyBytes(record[name], name, false, depth + 1)
    if (entry !== null) {
      bytes += (emitted > 0 ? 1 : 0) + jsonStringBytes(name) + 1 + entry
      emitted += 1
    }
  }
  return bytes
}
