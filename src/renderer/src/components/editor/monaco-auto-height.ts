export const MONACO_AUTO_HEIGHT_LINE_SCAN_CODE_UNITS = 64 * 1024
export const MONACO_AUTO_HEIGHT_MAX_LINES = 2_000
const MONACO_AUTO_HEIGHT_EXTRA_PX = 18
const MONACO_AUTO_HEIGHT_MIN_PX = 80

export function getMonacoAutoHeightForContent(content: string, lineHeight: number): number {
  const lineCount = countMonacoAutoHeightLines(content)
  return clampMonacoAutoHeight(lineCount * lineHeight + MONACO_AUTO_HEIGHT_EXTRA_PX, lineHeight)
}

export function clampMonacoAutoHeight(height: number, lineHeight: number): number {
  return Math.max(
    MONACO_AUTO_HEIGHT_MIN_PX,
    Math.min(Math.ceil(height), getMonacoAutoHeightMaxPx(lineHeight))
  )
}

export function isMonacoAutoHeightCapped(height: number | null, lineHeight: number): boolean {
  return height !== null && height >= getMonacoAutoHeightMaxPx(lineHeight)
}

function countMonacoAutoHeightLines(content: string): number {
  if (content.length === 0) {
    return 1
  }

  const scanLength = Math.min(content.length, MONACO_AUTO_HEIGHT_LINE_SCAN_CODE_UNITS)
  let lineCount = 1
  for (let index = 0; index < scanLength; index += 1) {
    if (content.charCodeAt(index) !== 10) {
      continue
    }
    lineCount += 1
    if (lineCount >= MONACO_AUTO_HEIGHT_MAX_LINES) {
      return MONACO_AUTO_HEIGHT_MAX_LINES
    }
  }
  return lineCount
}

function getMonacoAutoHeightMaxPx(lineHeight: number): number {
  return MONACO_AUTO_HEIGHT_MAX_LINES * lineHeight + MONACO_AUTO_HEIGHT_EXTRA_PX
}
