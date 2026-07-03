import type { editor, IRange } from 'monaco-editor'

type ConflictBlock = {
  startLine: number
  baseLine?: number
  separatorLine: number
  endLine: number
}

type ParsedConflictBlock = ConflictBlock & {
  startText: string
  baseText?: string
  separatorText: string
  endText: string
}

type ConflictSection = 'current' | 'base' | 'incoming'

function getLineEndColumn(line: string): number {
  return line.length + 1
}

function makeWholeLineRange(startLineNumber: number, endLineNumber: number): IRange {
  return {
    startLineNumber,
    startColumn: 1,
    endLineNumber,
    endColumn: 1
  }
}

function makeMarkerRange(lineNumber: number, line: string): IRange {
  return {
    startLineNumber: lineNumber,
    startColumn: 1,
    endLineNumber: lineNumber,
    endColumn: getLineEndColumn(line)
  }
}

function makeMarkerDecoration(
  lineNumber: number,
  line: string,
  label: string
): editor.IModelDeltaDecoration {
  return {
    range: makeMarkerRange(lineNumber, line),
    options: {
      isWholeLine: true,
      className: 'orca-conflict-marker-line',
      linesDecorationsClassName: 'orca-conflict-line-decoration',
      marginClassName: 'orca-conflict-margin',
      hoverMessage: { value: label },
      linesDecorationsTooltip: label,
      after: {
        content: ` ${label}`,
        inlineClassName: 'orca-conflict-marker-label'
      }
    }
  }
}

function makeSectionDecoration(
  startLineNumber: number,
  endLineNumber: number,
  section: ConflictSection
): editor.IModelDeltaDecoration | null {
  if (startLineNumber > endLineNumber) {
    return null
  }

  return {
    range: makeWholeLineRange(startLineNumber, endLineNumber),
    options: {
      isWholeLine: true,
      className: `orca-conflict-section-line orca-conflict-${section}-line`
    }
  }
}

export function findGitConflictBlocks(content: string): ConflictBlock[] {
  return parseGitConflictBlocks(content).map(({ startLine, baseLine, separatorLine, endLine }) => ({
    startLine,
    ...(baseLine === undefined ? {} : { baseLine }),
    separatorLine,
    endLine
  }))
}

export function getGitConflictMarkerLineLength(content: string, lineNumber: number): number {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    return 0
  }
  let foundLength = 0
  forEachLine(content, (lineStart, lineEnd, currentLineNumber) => {
    if (currentLineNumber !== lineNumber) {
      return
    }
    foundLength = lineEnd - lineStart
    return false
  })
  return foundLength
}

function parseGitConflictBlocks(content: string): ParsedConflictBlock[] {
  const blocks: ParsedConflictBlock[] = []
  let current: {
    startLine: number
    startText: string
    baseLine?: number
    baseText?: string
    separatorLine?: number
    separatorText?: string
  } | null = null

  forEachLine(content, (lineStart, lineEnd, lineNumber) => {
    if (lineStartsWith(content, lineStart, lineEnd, '<<<<<<<')) {
      current = { startLine: lineNumber, startText: content.slice(lineStart, lineEnd) }
      return
    }

    if (!current) {
      return
    }

    if (lineStartsWith(content, lineStart, lineEnd, '|||||||')) {
      current.baseLine = lineNumber
      current.baseText = content.slice(lineStart, lineEnd)
      return
    }

    if (lineEquals(content, lineStart, lineEnd, '=======')) {
      current.separatorLine = lineNumber
      current.separatorText = '======='
      return
    }

    if (lineStartsWith(content, lineStart, lineEnd, '>>>>>>>')) {
      if (current.separatorLine && current.separatorText) {
        blocks.push({
          startLine: current.startLine,
          startText: current.startText,
          baseLine: current.baseLine,
          baseText: current.baseText,
          separatorLine: current.separatorLine,
          separatorText: current.separatorText,
          endLine: lineNumber,
          endText: content.slice(lineStart, lineEnd)
        })
      }
      current = null
    }
  })

  return blocks
}

export function hasGitConflictMarkers(content: string): boolean {
  let found = false
  forEachLine(content, (lineStart, lineEnd) => {
    found =
      lineStartsWith(content, lineStart, lineEnd, '<<<<<<<') ||
      lineStartsWith(content, lineStart, lineEnd, '|||||||') ||
      lineEquals(content, lineStart, lineEnd, '=======') ||
      lineStartsWith(content, lineStart, lineEnd, '>>>>>>>')
    return found ? false : undefined
  })
  return found
}

export function buildGitConflictDecorations(content: string): editor.IModelDeltaDecoration[] {
  const decorations: editor.IModelDeltaDecoration[] = []

  for (const block of parseGitConflictBlocks(content)) {
    const currentEndLine = (block.baseLine ?? block.separatorLine) - 1
    const baseStartLine = block.baseLine ? block.baseLine + 1 : null
    const sectionDecorations = [
      makeSectionDecoration(block.startLine + 1, currentEndLine, 'current'),
      baseStartLine ? makeSectionDecoration(baseStartLine, block.separatorLine - 1, 'base') : null,
      makeSectionDecoration(block.separatorLine + 1, block.endLine - 1, 'incoming')
    ]

    for (const decoration of sectionDecorations) {
      if (decoration) {
        decorations.push(decoration)
      }
    }

    decorations.push(
      makeMarkerDecoration(block.startLine, block.startText, 'Current change'),
      ...(block.baseLine
        ? [makeMarkerDecoration(block.baseLine, block.baseText ?? '', 'Common ancestor')]
        : []),
      makeMarkerDecoration(block.separatorLine, block.separatorText, 'Incoming change'),
      makeMarkerDecoration(block.endLine, block.endText, 'End conflict')
    )
  }

  return decorations
}

function forEachLine(
  content: string,
  visit: (lineStart: number, lineEnd: number, lineNumber: number) => boolean | void
): void {
  let lineStart = 0
  let lineNumber = 1
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    if (visit(lineStart, lineEnd, lineNumber) === false) {
      return
    }
    lineStart = index + 1
    lineNumber += 1
  }
}

function lineStartsWith(
  content: string,
  lineStart: number,
  lineEnd: number,
  prefix: string
): boolean {
  return lineEnd - lineStart >= prefix.length && content.startsWith(prefix, lineStart)
}

function lineEquals(content: string, lineStart: number, lineEnd: number, value: string): boolean {
  return lineEnd - lineStart === value.length && content.startsWith(value, lineStart)
}
