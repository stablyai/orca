import { forEachMarkdownLine } from './markdown-fence-scanner'

type FenceContainer = { kind: 'quote' } | { kind: 'list'; size: number }

type FenceMarker = { marker: string; length: number; column: number }

function quoteContentStart(line: string, index: number): number {
  let cursor = index
  let spaces = 0
  while (line[cursor] === ' ' && spaces < 3) {
    cursor += 1
    spaces += 1
  }
  if (line[cursor] !== '>') {
    return -1
  }
  return line[cursor + 1] === ' ' ? cursor + 2 : cursor + 1
}

function blankFrom(line: string, index: number): boolean {
  return /^ *$/.test(line.slice(index))
}

function listItemOpener(line: string, index: number): { size: number; next: number } | null {
  let cursor = index
  let indent = 0
  while (line[cursor] === ' ' && indent < 3) {
    cursor += 1
    indent += 1
  }

  const marker = line[cursor]
  if (marker === '-' || marker === '+' || marker === '*') {
    cursor += 1
  } else if (marker >= '0' && marker <= '9') {
    let digits = 0
    while (line[cursor] >= '0' && line[cursor] <= '9' && digits < 9) {
      cursor += 1
      digits += 1
    }
    if (digits === 0 || (line[cursor] !== '.' && line[cursor] !== ')')) {
      return null
    }
    cursor += 1
  } else {
    return null
  }
  if (line[cursor] !== ' ') {
    return null
  }

  let spaces = 0
  while (line[cursor + spaces] === ' ') {
    spaces += 1
  }
  const padding = spaces > 4 ? 1 : spaces
  return { size: cursor + padding - index, next: cursor + padding }
}

function continueFenceContainers(
  line: string,
  containers: readonly FenceContainer[]
): { containers: FenceContainer[]; index: number } {
  const kept: FenceContainer[] = []
  let index = 0
  for (let frameIndex = 0; frameIndex < containers.length; frameIndex += 1) {
    const frame = containers[frameIndex]
    if (frame.kind === 'quote') {
      const next = quoteContentStart(line, index)
      if (next < 0) {
        return { containers: kept, index }
      }
      kept.push(frame)
      index = next
      continue
    }
    if (blankFrom(line, index)) {
      for (let rest = frameIndex; rest < containers.length; rest += 1) {
        if (containers[rest].kind === 'quote') {
          break
        }
        kept.push(containers[rest])
      }
      return { containers: kept, index }
    }
    let spaces = 0
    while (line[index + spaces] === ' ' && spaces < frame.size) {
      spaces += 1
    }
    if (spaces !== frame.size) {
      return { containers: kept, index }
    }
    kept.push(frame)
    index += frame.size
  }
  return { containers: kept, index }
}

function openFenceContainers(
  line: string,
  index: number,
  containers: readonly FenceContainer[]
): { containers: FenceContainer[]; index: number } {
  const next = containers.slice()
  let cursor = index
  for (;;) {
    const quote = quoteContentStart(line, cursor)
    if (quote >= 0) {
      next.push({ kind: 'quote' })
      cursor = quote
      continue
    }
    const list = listItemOpener(line, cursor)
    if (!list) {
      return { containers: next, index: cursor }
    }
    next.push({ kind: 'list', size: list.size })
    cursor = list.next
  }
}

function fenceMarker(line: string, index: number): FenceMarker | null {
  let cursor = index
  let indent = 0
  while (line[cursor] === ' ' && indent < 3) {
    cursor += 1
    indent += 1
  }
  const marker = line[cursor]
  if (marker !== '`' && marker !== '~') {
    return null
  }
  let length = 0
  while (line[cursor + length] === marker) {
    length += 1
  }
  if (length < 3) {
    return null
  }
  if (marker === '`') {
    for (let info = cursor + length; info < line.length; info += 1) {
      if (line[info] === '`') {
        return null
      }
    }
  }
  return { marker, length, column: cursor + 1 }
}

function fenceLineCloses(
  line: string,
  containers: readonly FenceContainer[],
  marker: string,
  length: number
): boolean {
  const continued = continueFenceContainers(line, containers)
  if (continued.containers.length !== containers.length) {
    return false
  }
  let cursor = continued.index
  let indent = 0
  while (line[cursor] === ' ' && indent < 3) {
    cursor += 1
    indent += 1
  }
  if (line[cursor] !== marker) {
    return false
  }
  let run = 0
  while (line[cursor] === marker) {
    cursor += 1
    run += 1
  }
  if (run < length) {
    return false
  }
  for (let rest = cursor; rest < line.length; rest += 1) {
    if (line[rest] !== ' ') {
      return false
    }
  }
  return true
}

// Why: the root fence scanner misses a mermaid opener inside a blockquote, a
// list, or a list item indented past three spaces. The code node's end line is
// only a candidate closer — it has to repeat that container and use the same
// marker, at least as long, or a fence-like body line would count as closed.
export function markdownFenceIsClosed(
  content: string,
  openLine: number,
  openColumn: number,
  closeLine: number
): boolean {
  if (closeLine <= openLine || openColumn < 1) {
    return false
  }
  const lines: string[] = []
  forEachMarkdownLine(content, (lineStart, lineEnd) => {
    lines.push(content.slice(lineStart, lineEnd))
  })
  if (openLine > lines.length || closeLine > lines.length) {
    return false
  }

  let containers: FenceContainer[] = []
  let hidden: { marker: string; length: number; containers: FenceContainer[] } | null = null
  for (let lineNumber = 1; lineNumber <= closeLine; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? ''
    if (hidden) {
      if (fenceLineCloses(line, hidden.containers, hidden.marker, hidden.length)) {
        hidden = null
      }
      continue
    }

    const continued = continueFenceContainers(line, containers)
    const opened = openFenceContainers(line, continued.index, continued.containers)
    const opening = fenceMarker(line, opened.index)
    containers = opened.containers
    if (!opening) {
      continue
    }
    if (lineNumber === openLine) {
      return (
        opening.column === openColumn &&
        fenceLineCloses(lines[closeLine - 1] ?? '', containers, opening.marker, opening.length)
      )
    }
    hidden = { marker: opening.marker, length: opening.length, containers }
  }
  return false
}
