// Share Monaco-free range rules across gutter, keyboard and markdown annotations.

export type DiffCommentLineRange = {
  startLine: number
  endLine: number
}

/** Wire shape the composer and store expect: `startLine` is omitted for a single line. */
export type DiffCommentLineTarget = {
  lineNumber: number
  startLine?: number
}

type LineSelection = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/** Monaco's `Selection`: ordered bounds plus the anchor/active endpoint the user dragged from. */
type DirectionalLineSelection = LineSelection & {
  selectionStartLineNumber: number
  positionLineNumber: number
}

export function orderLineRange(anchorLine: number, focusLine: number): DiffCommentLineRange {
  return {
    startLine: Math.min(anchorLine, focusLine),
    endLine: Math.max(anchorLine, focusLine)
  }
}

export function areLineRangesEqual(
  a: DiffCommentLineRange | null,
  b: DiffCommentLineRange | null
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.startLine === b.startLine && a.endLine === b.endLine
}

export function toDiffCommentLineTarget(range: DiffCommentLineRange): DiffCommentLineTarget {
  return {
    lineNumber: range.endLine,
    startLine: range.startLine === range.endLine ? undefined : range.startLine
  }
}

// Clamp at the hunk edge instead of jumping an uncommentable gap.
export function clampFocusLineToCommentable(
  anchorLine: number,
  focusLine: number,
  commentableLines: ReadonlySet<number> | null
): number {
  if (commentableLines === null || focusLine === anchorLine) {
    return focusLine
  }
  const step = focusLine > anchorLine ? 1 : -1
  let reachable = anchorLine
  for (
    let line = anchorLine + step;
    step > 0 ? line <= focusLine : line >= focusLine;
    line += step
  ) {
    if (!commentableLines.has(line)) {
      break
    }
    reachable = line
  }
  return reachable
}

// A selection ending at column one excludes that trailing line, including markdown annotations.
export function getSelectionEndLine(selection: LineSelection): number {
  if (selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber) {
    return selection.endLineNumber - 1
  }
  return selection.endLineNumber
}

// Sorted bounds lose drag direction; clamping needs the original anchor to choose the correct hunk.
export function getSelectionAnchorFocus(selection: DirectionalLineSelection): {
  anchorLine: number
  focusLine: number
} {
  const endLine = getSelectionEndLine(selection)
  return selection.positionLineNumber < selection.selectionStartLineNumber
    ? { anchorLine: endLine, focusLine: selection.positionLineNumber }
    : { anchorLine: selection.selectionStartLineNumber, focusLine: endLine }
}
