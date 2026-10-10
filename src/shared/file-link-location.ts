export type ParsedFileLinkLocation = {
  pathText: string
  line: number | null
  column: number | null
}

export function parseFileLinkLocation(value: string): ParsedFileLinkLocation | null {
  if (!value || /[\r\n\u2028\u2029]/.test(value)) {
    return null
  }
  // Only trailing digits can carry a location; don't retry suffixes at every path character.
  const match = /\d$/.test(value) ? /:(\d+)(?::(\d+))?$/.exec(value) : null
  const pathText = match ? value.slice(0, match.index) : value
  if (!pathText) {
    return null
  }
  const line = match ? Number.parseInt(match[1], 10) : null
  const column = match?.[2] ? Number.parseInt(match[2], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }
  return { pathText, line, column }
}

/** Inverse of `parseFileLinkLocation`: `path`, `path:line`, or `path:line:column`. */
export function formatFileLinkLocation(location: {
  pathText: string
  line: number | null
  column?: number | null
}): string {
  if (location.line === null) {
    return location.pathText
  }
  const column = location.column == null ? '' : `:${location.column}`
  return `${location.pathText}:${location.line}${column}`
}
