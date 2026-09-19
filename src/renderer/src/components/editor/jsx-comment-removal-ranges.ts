import type { ISelection } from 'monaco-editor'

const JSX_COMMENT_START = '{/*'
const JSX_COMMENT_END = '*/}'

export type JsxCommentRemovalRange = {
  startOffset: number
  endOffset: number
}

type SelectionRange = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

function getSelectionRange(
  selection: ISelection,
  lineStarts: readonly number[],
  lineEnds: readonly number[]
): SelectionRange {
  const anchorBeforeActive =
    selection.selectionStartLineNumber < selection.positionLineNumber ||
    (selection.selectionStartLineNumber === selection.positionLineNumber &&
      selection.selectionStartColumn <= selection.positionColumn)
  const orderedRange = anchorBeforeActive
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
  if (orderedRange.endLineNumber > orderedRange.startLineNumber && orderedRange.endColumn === 1) {
    const endLineNumber = orderedRange.endLineNumber - 1
    return {
      ...orderedRange,
      endLineNumber,
      endColumn: lineEnds[endLineNumber - 1] - lineStarts[endLineNumber - 1] + 1
    }
  }
  return orderedRange
}

function getLineText(
  source: string,
  lineStarts: readonly number[],
  lineEnds: readonly number[],
  lineNumber: number
): string {
  return source.slice(lineStarts[lineNumber - 1], lineEnds[lineNumber - 1])
}

function getFirstNonWhitespaceColumn(line: string): number {
  const index = line.search(/\S/)
  return index === -1 ? 0 : index + 1
}

function getSignificantSelectionRange(
  source: string,
  startOffset: number,
  endOffset: number
): JsxCommentRemovalRange | null {
  if (startOffset === endOffset) {
    return { startOffset, endOffset }
  }
  const selectedText = source.slice(startOffset, endOffset)
  const firstContentIndex = selectedText.search(/\S/)
  if (firstContentIndex === -1) {
    return null
  }
  return {
    startOffset: startOffset + firstContentIndex,
    endOffset: endOffset - (selectedText.length - selectedText.trimEnd().length)
  }
}

function hasExactlyOneCommentPair(source: string, startOffset: number, endOffset: number): boolean {
  const candidate = source.slice(startOffset, endOffset)
  const firstEndTokenIndex = candidate.indexOf(JSX_COMMENT_END)
  return (
    !candidate.slice(JSX_COMMENT_START.length).includes(JSX_COMMENT_START) &&
    firstEndTokenIndex !== -1 &&
    !candidate.slice(firstEndTokenIndex + JSX_COMMENT_END.length).includes(JSX_COMMENT_END)
  )
}

export function findJsxCommentRemovalRanges(
  source: string,
  lineStarts: readonly number[],
  lineEnds: readonly number[],
  selection: ISelection
): JsxCommentRemovalRange[] | null {
  const range = getSelectionRange(selection, lineStarts, lineEnds)
  let startLineNumber = range.startLineNumber
  let endLineNumber = range.endLineNumber
  let startLine = getLineText(source, lineStarts, lineEnds, startLineNumber)
  let endLine = getLineText(source, lineStarts, lineEnds, endLineNumber)
  const startTokenAllowedBeforeColumn =
    JSX_COMMENT_END.length + Math.max(getFirstNonWhitespaceColumn(startLine), range.startColumn)
  let startTokenIndex = startLine.lastIndexOf(JSX_COMMENT_START, startTokenAllowedBeforeColumn - 1)
  let endTokenIndex = endLine.indexOf(
    JSX_COMMENT_END,
    range.endColumn - 1 - JSX_COMMENT_START.length
  )

  if (startTokenIndex !== -1 && endTokenIndex === -1) {
    endTokenIndex = startLine.indexOf(JSX_COMMENT_END, startTokenIndex + JSX_COMMENT_START.length)
    endLineNumber = startLineNumber
    endLine = startLine
  }
  if (startTokenIndex === -1 && endTokenIndex !== -1) {
    startTokenIndex = endLine.lastIndexOf(JSX_COMMENT_START, endTokenIndex)
    startLineNumber = endLineNumber
    startLine = endLine
  }

  if (startTokenIndex === -1 || endTokenIndex === -1) {
    return null
  }

  const commentStartOffset = lineStarts[startLineNumber - 1] + startTokenIndex
  const commentEndOffset = lineStarts[endLineNumber - 1] + endTokenIndex + JSX_COMMENT_END.length
  const selectionRange = getSignificantSelectionRange(
    source,
    lineStarts[range.startLineNumber - 1] + range.startColumn - 1,
    lineStarts[range.endLineNumber - 1] + range.endColumn - 1
  )
  if (
    !selectionRange ||
    commentStartOffset > selectionRange.startOffset ||
    commentEndOffset < selectionRange.endOffset ||
    !hasExactlyOneCommentPair(source, commentStartOffset, commentEndOffset)
  ) {
    return null
  }

  let startTokenEndIndex = startTokenIndex + JSX_COMMENT_START.length
  if (startLine.charCodeAt(startTokenEndIndex) === 32) {
    startTokenEndIndex += 1
  }
  let endTokenStartIndex = endTokenIndex
  if (endLine.charCodeAt(endTokenStartIndex - 1) === 32) {
    endTokenStartIndex -= 1
  }

  return [
    {
      startOffset: commentStartOffset,
      endOffset: lineStarts[startLineNumber - 1] + startTokenEndIndex
    },
    {
      startOffset: lineStarts[endLineNumber - 1] + endTokenStartIndex,
      endOffset: lineStarts[endLineNumber - 1] + endTokenIndex + JSX_COMMENT_END.length
    }
  ]
}
