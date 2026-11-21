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

/** Strips exactly `levels` CommonMark blockquote markers (0-3 spaces, `>`, optional space). */
export function stripBlockquoteLevels(line: string, levels: number): string | null {
  let index = 0
  for (let level = 0; level < levels; level += 1) {
    let spaces = 0
    while (index < line.length && spaces < 3 && line.charCodeAt(index) === 32) {
      index += 1
      spaces += 1
    }
    if (index >= line.length || line.charCodeAt(index) !== 62) {
      return null
    }
    index += 1
    if (index < line.length && line.charCodeAt(index) === 32) {
      index += 1
    }
  }
  return line.slice(index)
}

export function stripAllBlockquotePrefixes(line: string): {
  depth: number
  content: string
  prefixLength: number
} {
  let depth = 0
  let index = 0
  while (index < line.length) {
    let cursor = index
    let spaces = 0
    while (cursor < line.length && spaces < 3 && line.charCodeAt(cursor) === 32) {
      cursor += 1
      spaces += 1
    }
    if (cursor >= line.length || line.charCodeAt(cursor) !== 62) {
      break
    }
    cursor += 1
    if (cursor < line.length && line.charCodeAt(cursor) === 32) {
      cursor += 1
    }
    depth += 1
    index = cursor
  }
  return { depth, content: line.slice(index), prefixLength: index }
}

export function measureLeadingColumns(text: string): { columns: number; offset: number } {
  let columns = 0
  let offset = 0
  while (offset < text.length) {
    const ch = text.charCodeAt(offset)
    if (ch === 32) {
      columns += 1
      offset += 1
    } else if (ch === 9) {
      columns += 4 - (columns % 4)
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
): { containerLine: string; columns: number; offset: number; isBlank: boolean } | null {
  const containerLine = quoteDepth === 0 ? line : stripBlockquoteLevels(line, quoteDepth)
  if (containerLine === null) {
    return null
  }
  const { columns, offset } = measureLeadingColumns(containerLine)
  const isBlank = offset === containerLine.length
  if (!isBlank && columns < containerIndent) {
    return null
  }
  return { containerLine, columns, offset, isBlank }
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
    prefixLength
  } = stripAllBlockquotePrefixes(line)
  while ((containers.at(-1)?.quoteDepth ?? -1) > quoteDepth) {
    containers.pop()
  }

  const { columns, offset } = measureLeadingColumns(lineWithoutQuote)
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
