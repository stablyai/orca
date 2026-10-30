export class JsonStringifyByteLimitError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`JSON output exceeds ${maxBytes} bytes`)
    this.name = 'JsonStringifyByteLimitError'
  }
}

function jsonStringBytes(value: string): number {
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

function normalizedJsonValue(value: unknown, container: unknown): unknown {
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

function primitiveJsonBytes(value: unknown): number | null {
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

function rawJsonBytes(value: unknown): number | null {
  const isRawJSON = (JSON as { isRawJSON?: (candidate: unknown) => boolean }).isRawJSON
  if (!isRawJSON?.(value)) {
    return null
  }
  const rawJSON = (value as { rawJSON?: unknown }).rawJSON
  return typeof rawJSON === 'string' ? Buffer.byteLength(rawJSON, 'utf8') : null
}

function normalizedJsonIndent(space: number | string | undefined): string {
  if (typeof space === 'number') {
    const width = Number.isNaN(space) || space <= 0 ? 0 : Math.min(10, Math.trunc(space))
    return ' '.repeat(width)
  }
  return typeof space === 'string' ? space.slice(0, 10) : ''
}

export function stringifyJsonWithinByteLimit(
  value: unknown,
  maxBytes: number,
  space?: number | string
): { serialized: string; byteLength: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('JSON byte limit must be a non-negative safe integer')
  }

  let bytes = 0
  let root = true
  const emittedProperties = new WeakMap<object, number>()
  const containerDepths = new WeakMap<object, number>()
  const indent = normalizedJsonIndent(space)
  const indentBytes = Buffer.byteLength(indent, 'utf8')
  const addBytes = (count: number): void => {
    bytes += count
    if (bytes > maxBytes) {
      throw new JsonStringifyByteLimitError(bytes, maxBytes)
    }
  }

  const serialized = JSON.stringify(
    value,
    function (key, rawValue) {
      const normalized = normalizedJsonValue(rawValue, this)
      const isRoot = root
      root = false
      if (normalized === undefined) {
        return undefined
      }

      if (!isRoot) {
        const emitted = emittedProperties.get(this) ?? 0
        const parentDepth = containerDepths.get(this) ?? 0
        if (indentBytes > 0) {
          if (emitted === 0) {
            addBytes(2 + indentBytes * (parentDepth * 2 + 1))
          } else {
            addBytes(2 + indentBytes * (parentDepth + 1))
          }
        } else if (emitted > 0) {
          addBytes(1)
        }
        if (!Array.isArray(this)) {
          addBytes(jsonStringBytes(key) + 1 + (indentBytes > 0 ? 1 : 0))
        }
        emittedProperties.set(this, emitted + 1)
      }

      const encodedBytes = rawJsonBytes(normalized) ?? primitiveJsonBytes(normalized)
      if (encodedBytes !== null) {
        addBytes(encodedBytes)
      } else if (normalized !== null && typeof normalized === 'object') {
        addBytes(2)
        emittedProperties.set(normalized, 0)
        const parentDepth = isRoot ? -1 : (containerDepths.get(this) ?? 0)
        containerDepths.set(normalized, parentDepth + 1)
      }
      return normalized
    },
    space
  )

  if (serialized === undefined) {
    throw new TypeError('JSON value is not serializable')
  }
  const actualBytes = Buffer.byteLength(serialized, 'utf8')
  if (actualBytes > maxBytes) {
    throw new JsonStringifyByteLimitError(actualBytes, maxBytes)
  }
  return { serialized, byteLength: actualBytes }
}
