const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

export function decodeXmlAttributeEntities(value: string): string | null {
  let decoded = ''
  let cursor = 0
  for (const match of value.matchAll(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][\w.-]*));/g)) {
    const before = value.slice(cursor, match.index)
    if (before.includes('&')) {
      return null
    }
    decoded += before
    const named = match[3]
    const codePoint = match[1]
      ? Number.parseInt(match[1], 16)
      : match[2]
        ? Number.parseInt(match[2], 10)
        : named
          ? null
          : 0
    if (named) {
      const replacement = XML_ENTITIES[named]
      if (replacement === undefined) {
        return null
      }
      decoded += replacement
    } else if (codePoint !== null && isXmlCodePoint(codePoint)) {
      decoded += String.fromCodePoint(codePoint)
    } else {
      return null
    }
    cursor = (match.index ?? 0) + match[0].length
  }
  const rest = value.slice(cursor)
  return rest.includes('&') ? null : decoded + rest
}

function isXmlCodePoint(value: number): boolean {
  return (
    value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  )
}

/** A url() may only name a fragment in the same icon (a gradient, clip path or mask). */
export function isSafePluginIconAttributeValue(value: string): boolean {
  const decoded = decodeXmlAttributeEntities(value)
  if (
    decoded === null ||
    /javascript:|expression\s*\(|@import|[<>]/i.test(decoded) ||
    decoded.includes('\\')
  ) {
    return false
  }
  if (/(?:https?|ftp|file|data|blob):|\/\//i.test(decoded)) {
    return false
  }
  const urls = decoded.match(/url\s*\(([^)]*)\)/gi) ?? []
  return urls.every((url) => /^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/i.test(url))
}
