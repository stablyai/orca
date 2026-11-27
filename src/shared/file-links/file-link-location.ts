export type ParsedFileLinkLocation = {
  pathText: string
  line: number | null
  column: number | null
}

function collapseRepeatedTrailingFilename(pathText: string): string {
  const lastSep = Math.max(pathText.lastIndexOf('/'), pathText.lastIndexOf('\\'))
  const basename = pathText.slice(lastSep + 1)
  if (basename.length >= 4 && basename.length % 2 === 0) {
    const half = basename.slice(0, basename.length / 2)
    if (basename.slice(basename.length / 2) === half && /\.[A-Za-z0-9_+-]+$/.test(half)) {
      return `${pathText.slice(0, lastSep + 1)}${half}`
    }
  }
  const partialMatch = /^(.+\.[A-Za-z0-9_+-]{1,8})([^.\\/]+)$/u.exec(basename)
  if (partialMatch) {
    const stemWithExt = partialMatch[1]!
    const trailingRepeat = partialMatch[2]!
    if (trailingRepeat.length >= 2 && stemWithExt.startsWith(trailingRepeat)) {
      return `${pathText.slice(0, lastSep + 1)}${stemWithExt}`
    }
  }
  return pathText
}

export function parseFileLinkLocation(value: string): ParsedFileLinkLocation | null {
  const match =
    /^(.*?)(?:#(?:L|line-?)(\d+)(?:C(\d+))?(?:-(?:L|line-?)?\d+(?:C\d+)?)?|(?::(\d+)(?:-\d+)?)(?::(\d+))?)?$/i.exec(
      value
    )
  const rawPathText = match?.[1]
  if (!rawPathText) {
    return null
  }
  const pathText = collapseRepeatedTrailingFilename(rawPathText)
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
