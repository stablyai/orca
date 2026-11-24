export type JsonRpcPrefix =
  | { kind: 'response'; id: number }
  | { kind: 'server-request'; id: number | string; method: string }
  | { kind: 'notification'; method: string }
  | { kind: 'response-unknown' }
  | { kind: 'unknown' }

export type LeadingProperty = { key: string; value?: string | number }

function readJsonStringEnd(value: string, start: number): number | null {
  if (value[start] !== '"') {
    return null
  }
  let escaped = false
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '"') {
      return index + 1
    }
  }
  return null
}

function skipJsonContainer(value: string, start: number): number | null {
  const opening = value[start]
  const closing = opening === '{' ? '}' : opening === '[' ? ']' : null
  if (!closing) {
    return null
  }
  const stack = [closing]
  let escaped = false
  let inString = false
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      stack.push('}')
    } else if (character === '[') {
      stack.push(']')
    } else if (character === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) {
        return index + 1
      }
    }
  }
  return null
}

function skipJsonLiteral(value: string, start: number): number | null {
  for (const literal of ['true', 'false', 'null']) {
    if (value.startsWith(literal, start)) {
      return start + literal.length
    }
  }
  return null
}

/**
 * The leading top-level fields of a JSON object, read without parsing it. With `stopAtContainer`,
 * the scan ends at the first object or array value (its key is still listed), so an envelope's
 * `params`/`result` payload is never walked.
 */
export function leadingJsonProperties(
  prefix: string,
  options: { stopAtContainer?: boolean } = {}
): LeadingProperty[] {
  const properties: LeadingProperty[] = []
  let cursor = 0
  const skipWhitespace = (): void => {
    while (/\s/.test(prefix[cursor] ?? '')) {
      cursor += 1
    }
  }
  skipWhitespace()
  if (prefix[cursor] !== '{') {
    return properties
  }
  cursor += 1
  while (properties.length < 8) {
    skipWhitespace()
    const keyEnd = readJsonStringEnd(prefix, cursor)
    if (keyEnd === null) {
      break
    }
    let key: unknown
    try {
      key = JSON.parse(prefix.slice(cursor, keyEnd))
    } catch {
      break
    }
    cursor = keyEnd
    skipWhitespace()
    if (prefix[cursor] !== ':') {
      break
    }
    cursor += 1
    skipWhitespace()
    if (prefix[cursor] === '{' || prefix[cursor] === '[') {
      properties.push({ key: String(key) })
      if (options.stopAtContainer) {
        break
      }
      const valueEnd = skipJsonContainer(prefix, cursor)
      if (valueEnd === null) {
        break
      }
      cursor = valueEnd
      skipWhitespace()
      if (prefix[cursor] !== ',') {
        break
      }
      cursor += 1
      continue
    }
    const literalEnd = skipJsonLiteral(prefix, cursor)
    if (literalEnd !== null) {
      properties.push({ key: String(key) })
      cursor = literalEnd
      skipWhitespace()
      if (prefix[cursor] !== ',') {
        break
      }
      cursor += 1
      continue
    }
    const stringEnd = readJsonStringEnd(prefix, cursor)
    if (stringEnd !== null) {
      try {
        properties.push({ key: String(key), value: JSON.parse(prefix.slice(cursor, stringEnd)) })
      } catch {
        break
      }
      cursor = stringEnd
      skipWhitespace()
      if (prefix[cursor] !== ',') {
        break
      }
      cursor += 1
      continue
    }
    // The whole JSON number, so `1e3` or `1.5` is never read as a different id than it is.
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(prefix.slice(cursor))
    // A number running to the end of the prefix may be cut short, so it is not read.
    if (!match || cursor + match[0].length >= prefix.length) {
      break
    }
    properties.push({ key: String(key), value: Number(match[0]) })
    cursor += match[0].length
    skipWhitespace()
    if (prefix[cursor] !== ',') {
      break
    }
    cursor += 1
  }
  return properties
}

export function classifyJsonRpcPrefix(prefix: string): JsonRpcPrefix {
  // Inspect complete top-level fields only; nested result/params must not impersonate JSON-RPC envelope keys.
  const properties = leadingJsonProperties(prefix)
  const method = properties.find((property) => property.key === 'method')?.value
  const id = properties.find((property) => property.key === 'id')?.value
  if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
    return { kind: 'server-request', id, method }
  }
  if (
    typeof id === 'number' &&
    properties.some((property) => property.key === 'id') &&
    properties.some((property) => property.key === 'result' || property.key === 'error')
  ) {
    return { kind: 'response', id }
  }
  if (typeof id === 'number') {
    return { kind: 'response-unknown' }
  }
  if (typeof method === 'string' && properties.some((property) => property.key === 'params')) {
    return { kind: 'notification', method }
  }
  return { kind: 'unknown' }
}
