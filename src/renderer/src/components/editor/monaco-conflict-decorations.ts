import type { editor, IRange } from 'monaco-editor'

type ConflictBlock = {
  startLine: number
  baseLine?: number
  separatorLine: number
  endLine: number
}

type ConflictSection = 'current' | 'base' | 'incoming'

function isGitConflictMarkerLine(line: string): boolean {
  return (
    line.startsWith('<<<<<<<') ||
    line.startsWith('|||||||') ||
    line === '=======' ||
    line.startsWith('>>>>>>>')
  )
}

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
  const lines = content.split(/\r?\n/)
  const blocks: ConflictBlock[] = []
  let current: {
    startLine: number
    baseLine?: number
    separatorLine?: number
  } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1

    if (line.startsWith('<<<<<<<')) {
      current = { startLine: lineNumber }
      continue
    }

    if (!current) {
      continue
    }

    if (line.startsWith('|||||||')) {
      current.baseLine = lineNumber
      continue
    }

    if (line === '=======') {
      current.separatorLine = lineNumber
      continue
    }

    if (line.startsWith('>>>>>>>')) {
      if (current.separatorLine) {
        blocks.push({
          startLine: current.startLine,
          baseLine: current.baseLine,
          separatorLine: current.separatorLine,
          endLine: lineNumber
        })
      }
      current = null
    }
  }

  return blocks
}

export function hasGitConflictMarkers(content: string): boolean {
  return content.split(/\r?\n/).some(isGitConflictMarkerLine)
}

export function buildGitConflictDecorations(content: string): editor.IModelDeltaDecoration[] {
  const lines = content.split(/\r?\n/)
  const decorations: editor.IModelDeltaDecoration[] = []

  for (const block of findGitConflictBlocks(content)) {
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
      makeMarkerDecoration(block.startLine, lines[block.startLine - 1] ?? '', 'Current change'),
      ...(block.baseLine
        ? [makeMarkerDecoration(block.baseLine, lines[block.baseLine - 1] ?? '', 'Common ancestor')]
        : []),
      makeMarkerDecoration(
        block.separatorLine,
        lines[block.separatorLine - 1] ?? '',
        'Incoming change'
      ),
      makeMarkerDecoration(block.endLine, lines[block.endLine - 1] ?? '', 'End conflict')
    )
  }

  return decorations
}
