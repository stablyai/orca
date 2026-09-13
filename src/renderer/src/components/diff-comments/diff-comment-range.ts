export function canCommentOnRange(
  startLine: number,
  endLine: number,
  commentableLines: ReadonlySet<number> | null
): boolean {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    Math.min(startLine, endLine) < 1
  ) {
    return false
  }
  if (commentableLines === null) {
    return true
  }
  const from = Math.min(startLine, endLine)
  const to = Math.max(startLine, endLine)
  if (to - from + 1 > commentableLines.size) {
    return false
  }
  for (let line = from; line <= to; line++) {
    if (!commentableLines.has(line)) {
      return false
    }
  }
  return true
}
