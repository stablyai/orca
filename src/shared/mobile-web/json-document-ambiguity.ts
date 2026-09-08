/**
 * Two hostile document shapes survive `JSON.parse` plus a strict zod schema, because both are lost
 * before the schema ever sees the value: a repeated key (parse keeps the last one silently) and an
 * unpaired surrogate (a valid JSON escape that is not valid text). Everything else the old
 * hand-written scanner checked — unknown keys, unsafe numbers, `__proto__` — the schema rejects.
 */
export function hasAmbiguousJsonText(raw: string, value: unknown): boolean {
  return hasDuplicateJsonKeys(raw) || hasLoneSurrogate(value)
}

/** Assumes `raw` already parsed, so the scan never has to handle malformed JSON. */
function hasDuplicateJsonKeys(raw: string): boolean {
  const containers: (Set<string> | null)[] = []
  let index = 0
  while (index < raw.length) {
    const character = raw[index]
    if (character === '{') {
      containers.push(new Set())
      index += 1
    } else if (character === '[') {
      containers.push(null)
      index += 1
    } else if (character === '}' || character === ']') {
      containers.pop()
      index += 1
    } else if (character === '"') {
      const end = endOfJsonString(raw, index)
      const keys = containers.at(-1)
      if (keys && raw[skipJsonWhitespace(raw, end)] === ':') {
        const key = JSON.parse(raw.slice(index, end)) as string
        if (keys.has(key)) {
          return true
        }
        keys.add(key)
      }
      index = end
    } else {
      index += 1
    }
  }
  return false
}

// Iterative rather than recursive: the walk is over attacker-shaped nesting.
function hasLoneSurrogate(value: unknown): boolean {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (isLoneSurrogateText(current)) {
        return true
      }
    } else if (Array.isArray(current)) {
      for (const entry of current) {
        pending.push(entry)
      }
    } else if (current && typeof current === 'object') {
      for (const [key, entry] of Object.entries(current)) {
        if (isLoneSurrogateText(key)) {
          return true
        }
        pending.push(entry)
      }
    }
  }
  return false
}

function isLoneSurrogateText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit < 0xd800 || unit > 0xdfff) {
      continue
    }
    const next = value.charCodeAt(index + 1)
    if (unit > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) {
      return true
    }
    index += 1
  }
  return false
}

function endOfJsonString(raw: string, start: number): number {
  let index = start + 1
  while (index < raw.length) {
    if (raw[index] === '\\') {
      index += 2
      continue
    }
    if (raw[index] === '"') {
      return index + 1
    }
    index += 1
  }
  return raw.length
}

function skipJsonWhitespace(raw: string, start: number): number {
  let index = start
  while (index < raw.length && ' \t\n\r'.includes(raw[index] ?? '')) {
    index += 1
  }
  return index
}
