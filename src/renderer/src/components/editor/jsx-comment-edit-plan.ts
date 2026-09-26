import type { IPosition, ISelection } from 'monaco-editor'
import { findJsxCommentRemovalRanges } from './jsx-comment-removal-ranges'

type JsxCommentOptions = {
  insertSpace: boolean
}

export type CommentTextEdit = {
  startOffset: number
  endOffset: number
  text: string
  moveAtPosition: boolean
  selectionOffsetAtPosition?: number
}

export type JsxCommentEditPlan = {
  edits: CommentTextEdit[]
  selections: ISelection[]
  finalSource: string
}

type SourceLines = {
  source: string
  starts: number[]
  ends: number[]
}

type SelectionRange = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

type SourceRange = {
  startOffset: number
  endOffset: number
}

function getSourceLines(source: string): SourceLines {
  const starts = [0]
  const ends: number[] = []
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index)
    if (codeUnit !== 10 && codeUnit !== 13) {
      continue
    }
    ends.push(index)
    if (codeUnit === 13 && source.charCodeAt(index + 1) === 10) {
      index += 1
    }
    starts.push(index + 1)
  }
  ends.push(source.length)
  return { source, starts, ends }
}

function getOffset(lines: SourceLines, position: IPosition): number {
  const lineStart = lines.starts[position.lineNumber - 1] ?? lines.source.length
  const lineEnd = lines.ends[position.lineNumber - 1] ?? lines.source.length
  return Math.min(lineStart + position.column - 1, lineEnd)
}

function getPosition(source: string, offset: number): IPosition {
  let lineNumber = 1
  let lineStart = 0
  for (let index = 0; index < Math.min(offset, source.length); index += 1) {
    const codeUnit = source.charCodeAt(index)
    if (codeUnit === 13) {
      if (source.charCodeAt(index + 1) === 10) {
        index += 1
      }
      lineNumber += 1
      lineStart = index + 1
    } else if (codeUnit === 10) {
      lineNumber += 1
      lineStart = index + 1
    }
  }
  return { lineNumber, column: Math.min(offset, source.length) - lineStart + 1 }
}

function getSelectionRange(selection: ISelection): SelectionRange {
  const anchorBeforeActive =
    selection.selectionStartLineNumber < selection.positionLineNumber ||
    (selection.selectionStartLineNumber === selection.positionLineNumber &&
      selection.selectionStartColumn <= selection.positionColumn)
  return anchorBeforeActive
    ? {
        startLineNumber: selection.selectionStartLineNumber,
        startColumn: selection.selectionStartColumn,
        endLineNumber: selection.positionLineNumber,
        endColumn: selection.positionColumn
      }
    : {
        startLineNumber: selection.positionLineNumber,
        startColumn: selection.positionColumn,
        endLineNumber: selection.selectionStartLineNumber,
        endColumn: selection.selectionStartColumn
      }
}

function getSelectedEndLine(range: SelectionRange): number {
  return range.endLineNumber > range.startLineNumber && range.endColumn === 1
    ? range.endLineNumber - 1
    : range.endLineNumber
}

function getFirstContentOffset(lines: SourceLines, lineNumber: number): number {
  const start = lines.starts[lineNumber - 1]
  const end = lines.ends[lineNumber - 1]
  const text = lines.source.slice(start, end)
  return start + (text.length - text.trimStart().length)
}

function getJsxSourceRange(lines: SourceLines, selection: ISelection): SourceRange {
  const range = getSelectionRange(selection)
  const startOffset = getFirstContentOffset(lines, range.startLineNumber)
  const endLine = getSelectedEndLine(range)
  const endOffset = lines.ends[endLine - 1]
  return { startOffset, endOffset }
}

function buildJsxEdits(
  lines: SourceLines,
  selection: ISelection,
  options: JsxCommentOptions
): CommentTextEdit[] {
  const removalRanges = findJsxCommentRemovalRanges(
    lines.source,
    lines.starts,
    lines.ends,
    selection
  )
  if (removalRanges) {
    return removalRanges.map((range) => ({
      ...range,
      text: '',
      moveAtPosition: false
    }))
  }
  const { startOffset, endOffset } = getJsxSourceRange(lines, selection)
  const selectedText = lines.source.slice(startOffset, endOffset)
  if (selectedText.includes('*/')) {
    return []
  }
  if (selectedText.length === 0) {
    return [
      {
        startOffset,
        endOffset: startOffset,
        text: '{/*  */}',
        moveAtPosition: false,
        selectionOffsetAtPosition: 4
      }
    ]
  }
  const openText = options.insertSpace ? '{/* ' : '{/*'
  const closeText = options.insertSpace ? ' */}' : '*/}'
  return [
    { startOffset, endOffset: startOffset, text: openText, moveAtPosition: true },
    { startOffset: endOffset, endOffset, text: closeText, moveAtPosition: false }
  ]
}

function hasOverlappingSelections(lines: SourceLines, selections: readonly ISelection[]): boolean {
  const ranges = selections
    .map((selection) => getJsxSourceRange(lines, selection))
    .sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset)
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]
    const current = ranges[index]
    const duplicate =
      current.startOffset === previous.startOffset && current.endOffset === previous.endOffset
    if (!duplicate && current.startOffset < previous.endOffset) {
      return true
    }
  }
  return false
}

function normalizeEdits(edits: CommentTextEdit[]): CommentTextEdit[] | null {
  const unique = new Map<string, CommentTextEdit>()
  for (const edit of edits) {
    const key = `${edit.startOffset}:${edit.endOffset}:${edit.text}`
    unique.set(key, edit)
  }
  const normalized = [...unique.values()].sort(
    (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset
  )
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startOffset < normalized[index - 1].endOffset) {
      return null
    }
  }
  return normalized
}

function applyEdits(source: string, edits: CommentTextEdit[]): string {
  let result = ''
  let sourceOffset = 0
  for (const edit of edits) {
    result += source.slice(sourceOffset, edit.startOffset) + edit.text
    sourceOffset = edit.endOffset
  }
  return result + source.slice(sourceOffset)
}

function transformOffset(offset: number, edits: CommentTextEdit[]): number {
  let delta = 0
  for (const edit of edits) {
    if (offset < edit.startOffset) {
      break
    }
    if (edit.startOffset === edit.endOffset) {
      if (offset > edit.startOffset) {
        delta += edit.text.length
      } else if (offset === edit.startOffset) {
        delta += edit.selectionOffsetAtPosition ?? (edit.moveAtPosition ? edit.text.length : 0)
      }
      continue
    }
    if (offset <= edit.endOffset) {
      return edit.startOffset + delta + edit.text.length
    }
    delta += edit.text.length - (edit.endOffset - edit.startOffset)
  }
  return offset + delta
}

function transformSelections(
  lines: SourceLines,
  finalSource: string,
  selections: readonly ISelection[],
  edits: CommentTextEdit[]
): ISelection[] {
  return selections.map((selection) => {
    const anchorOffset = transformOffset(
      getOffset(lines, {
        lineNumber: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn
      }),
      edits
    )
    const activeOffset = transformOffset(
      getOffset(lines, {
        lineNumber: selection.positionLineNumber,
        column: selection.positionColumn
      }),
      edits
    )
    const anchor = getPosition(finalSource, anchorOffset)
    const active = getPosition(finalSource, activeOffset)
    return {
      selectionStartLineNumber: anchor.lineNumber,
      selectionStartColumn: anchor.column,
      positionLineNumber: active.lineNumber,
      positionColumn: active.column
    }
  })
}

export function buildJsxCommentEditPlan(
  source: string,
  selections: readonly ISelection[],
  options: JsxCommentOptions
): JsxCommentEditPlan | null {
  const lines = getSourceLines(source)
  if (hasOverlappingSelections(lines, selections)) {
    return null
  }
  const edits = normalizeEdits(
    selections.flatMap((selection) => buildJsxEdits(lines, selection, options))
  )
  if (!edits) {
    return null
  }
  const finalSource = applyEdits(source, edits)
  return {
    edits,
    selections: transformSelections(lines, finalSource, selections, edits),
    finalSource
  }
}
