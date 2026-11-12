export type ParsedFileLinkLocation = {
  pathText: string
  line: number | null
  column: number | null
}

export function parseFileLinkLocation(value: string): ParsedFileLinkLocation | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  const pathText = match?.[1]
  if (!pathText) {
    return null
  }
  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
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
