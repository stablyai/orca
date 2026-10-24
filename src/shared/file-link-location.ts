export type ParsedFileLinkLocation = {
  pathText: string
  line: number | null
  column: number | null
}

export function parseFileLinkLocation(value: string): ParsedFileLinkLocation | null {
  const match =
    /^(.*?)(?:#(?:L|line-?)(\d+)(?:C(\d+))?(?:-(?:L|line-?)?\d+(?:C\d+)?)?|(?::(\d+)(?:-\d+)?)(?::(\d+))?)?$/i.exec(
      value
    )
  const pathText = match?.[1]
  if (!pathText) {
    return null
  }
  const lineRaw = match[2] ?? match[4]
  const columnRaw = match[3] ?? match[5]
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : null
  const column = columnRaw ? Number.parseInt(columnRaw, 10) : null
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
