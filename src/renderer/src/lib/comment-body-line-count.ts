export const COMMENT_BODY_LAYOUT_MAX_LINES = 80
export const COMMENT_BODY_LINE_COUNT_SCAN_CODE_UNITS = 64 * 1024

export function getCommentBodyLayoutLineCount(body: string): number {
  if (body.length === 0) {
    return 1
  }

  let lineCount = 1
  const scanLength = Math.min(body.length, COMMENT_BODY_LINE_COUNT_SCAN_CODE_UNITS)
  for (let index = 0; index < scanLength; index += 1) {
    if (body.charCodeAt(index) !== 10) {
      continue
    }
    lineCount += 1
    if (lineCount >= COMMENT_BODY_LAYOUT_MAX_LINES) {
      return COMMENT_BODY_LAYOUT_MAX_LINES
    }
  }
  return lineCount
}
