export type MarkdownContainer = {
  quoteDepth: number
  indent: number
}

export type MarkdownContainerLine = {
  contentIndent: number
  remainder: string
  startsIndentedCode: boolean
}

export function countBlockquoteDepth(prefix: string): number {
  let depth = 0
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix.charCodeAt(i) === 62) {
      depth += 1
    }
  }
  return depth
}

const THEMATIC_BREAK_PATTERN = /^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:\*[ \t]*){3,}$/

type BlockquotePrefixResult = {
  depth: number
  prefixLength: number
  content: string
  column: number
  virtualSpaces: number
}

function stripBlockquotePrefix(line: string, maxLevels: number): BlockquotePrefixResult {
  let depth = 0
  let index = 0
  let col = 0
  let virtualSpaces = 0

  while (depth < maxLevels && index < line.length) {
    let cursor = index
    let spaces = virtualSpaces
    let levelCol = col
    while (cursor < line.length && spaces < 3) {
      const ch = line.charCodeAt(cursor)
      if (ch === 32) {
        cursor += 1
        spaces += 1
        levelCol += 1
      } else if (ch === 9) {
        const tabWidth = 4 - (levelCol % 4)
        if (spaces + tabWidth > 3) {
          break
        }
        cursor += 1
        spaces += tabWidth
        levelCol += tabWidth
      } else {
        break
      }
    }
    if (cursor >= line.length || line.charCodeAt(cursor) !== 62) {
      break
    }
    cursor += 1
    levelCol += 1
    let nextVirtualSpaces = 0
    if (cursor < line.length) {
      const afterMarker = line.charCodeAt(cursor)
      if (afterMarker === 32) {
        cursor += 1
        levelCol += 1
      } else if (afterMarker === 9) {
        const tabWidth = 4 - (levelCol % 4)
        cursor += 1
        levelCol += tabWidth
        nextVirtualSpaces = tabWidth - 1
      }
    }
    depth += 1
    index = cursor
    col = levelCol
    virtualSpaces = nextVirtualSpaces
  }

  return {
    depth,
    prefixLength: index,
    content: line.slice(index),
    column: col,
    virtualSpaces
  }
}

/** Strips exactly `levels` CommonMark blockquote markers (0-3 spaces, `>`, optional space/tab column). */
export function stripBlockquoteLevels(line: string, levels: number): string | null {
  const stripped = stripBlockquotePrefix(line, levels)
  if (stripped.depth < levels) {
    return null
  }
  return stripped.virtualSpaces > 0
    ? ' '.repeat(stripped.virtualSpaces) + stripped.content
    : stripped.content
}

export function stripAllBlockquotePrefixes(line: string): BlockquotePrefixResult {
  return stripBlockquotePrefix(line, Number.POSITIVE_INFINITY)
}

export function measureLeadingColumns(
  text: string,
  startColumn = 0,
  initialColumns = 0
): { columns: number; offset: number } {
  let columns = initialColumns
  let visualColumn = startColumn
  let offset = 0
  while (offset < text.length) {
    const ch = text.charCodeAt(offset)
    if (ch === 32) {
      columns += 1
      visualColumn += 1
      offset += 1
    } else if (ch === 9) {
      const tabWidth = 4 - (visualColumn % 4)
      columns += tabWidth
      visualColumn += tabWidth
      offset += 1
    } else {
      break
    }
  }
  return { columns, offset }
}

export function detectContainerLine(
  text: string,
  columns: number,
  offset: number,
  baseIndent: number
): MarkdownContainerLine | null {
  if (columns > baseIndent + 3) {
    return null
  }
  const rest = text.slice(offset)
  const footnoteMatch = rest.match(/^\[\^[^\s[\]]+\]:(?:([ \t]+)|$)/)
  if (footnoteMatch) {
    return {
      contentIndent: baseIndent + 4,
      remainder: rest.slice(footnoteMatch[0].length),
      startsIndentedCode: false
    }
  }
  if (THEMATIC_BREAK_PATTERN.test(rest)) {
    return null
  }
  const listMatch = rest.match(/^([-+*]|\d{1,9}[.)])([ \t]+|$)/)
  if (!listMatch) {
    return null
  }
  const markerWidth = listMatch[1].length
  const ws = listMatch[2]
  const remainder = rest.slice(listMatch[0].length)
  if (ws.length === 0 || remainder.length === 0) {
    return { contentIndent: columns + markerWidth + 1, remainder, startsIndentedCode: false }
  }
  let col = columns + markerWidth
  for (let i = 0; i < ws.length; i += 1) {
    col += ws.charCodeAt(i) === 9 ? 4 - (col % 4) : 1
  }
  const wsCols = col - (columns + markerWidth)
  const startsIndentedCode = wsCols >= 5
  const contentIndent = startsIndentedCode ? columns + markerWidth + 1 : col
  return { contentIndent, remainder, startsIndentedCode }
}

export function matchContainerContinuation(
  line: string,
  quoteDepth: number,
  containerIndent: number
): {
  containerLine: string
  prefixLength: number
  columns: number
  offset: number
  isBlank: boolean
} | null {
  const stripped =
    quoteDepth === 0
      ? { depth: 0, prefixLength: 0, content: line, column: 0, virtualSpaces: 0 }
      : stripBlockquotePrefix(line, quoteDepth)
  if (stripped.depth < quoteDepth) {
    return null
  }
  const { columns, offset } = measureLeadingColumns(
    stripped.content,
    stripped.column,
    stripped.virtualSpaces
  )
  const isBlank = offset === stripped.content.length
  if (!isBlank && columns < containerIndent) {
    return null
  }
  return {
    containerLine: stripped.content,
    prefixLength: stripped.prefixLength,
    columns,
    offset,
    isBlank
  }
}

export function advanceContainerStackForLine(
  containers: MarkdownContainer[],
  line: string
): {
  quoteDepth: number
  lineWithoutQuote: string
  prefixLength: number
  columns: number
  offset: number
  isBlank: boolean
  baseIndent: number
  effectiveIndent: number
  container: MarkdownContainerLine | null
} {
  const {
    depth: quoteDepth,
    content: lineWithoutQuote,
    prefixLength,
    column,
    virtualSpaces
  } = stripAllBlockquotePrefixes(line)
  while ((containers.at(-1)?.quoteDepth ?? -1) > quoteDepth) {
    containers.pop()
  }

  const { columns, offset } = measureLeadingColumns(lineWithoutQuote, column, virtualSpaces)
  const isBlank = offset === lineWithoutQuote.length
  if (!isBlank) {
    while (
      containers.at(-1)?.quoteDepth === quoteDepth &&
      (containers.at(-1)?.indent ?? -1) > columns
    ) {
      containers.pop()
    }
  }

  const top = containers.at(-1)
  const baseIndent = top && top.quoteDepth === quoteDepth ? top.indent : 0
  const container =
    !isBlank && columns <= baseIndent + 3
      ? detectContainerLine(lineWithoutQuote, columns, offset, baseIndent)
      : null
  if (container && container.contentIndent > baseIndent) {
    containers.push({ quoteDepth, indent: container.contentIndent })
  }
  const effectiveIndent = container ? container.contentIndent : baseIndent
  return {
    quoteDepth,
    lineWithoutQuote,
    prefixLength,
    columns,
    offset,
    isBlank,
    baseIndent,
    effectiveIndent,
    container
  }
}
