import { diffArrays } from 'diff'

/** Pathological diffs give up rather than stall typing; blame then hides until the next edit. */
const DIFF_TIMEOUT_MS = 50

export const UNCOMMITTED_LINE = -1

/** Split like Monaco does, ignoring `\r` so CRLF checkouts don't read as edits. */
export function splitBlameLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/**
 * Map each buffer line (0-based) to the HEAD line it came from, or UNCOMMITTED_LINE for lines
 * added or changed since HEAD. Returns null when the diff gave up.
 */
export function mapBufferLinesToHead(
  headLines: string[],
  bufferLines: string[]
): Int32Array | null {
  const changes = diffArrays(headLines, bufferLines, { timeout: DIFF_TIMEOUT_MS })
  if (!changes) {
    return null
  }
  const mapping = new Int32Array(bufferLines.length)
  let headLine = 0
  let bufferLine = 0
  for (const change of changes) {
    const count = change.count
    if (change.removed) {
      headLine += count
    } else if (change.added) {
      mapping.fill(UNCOMMITTED_LINE, bufferLine, bufferLine + count)
      bufferLine += count
    } else {
      for (let i = 0; i < count; i++) {
        mapping[bufferLine++] = headLine++
      }
    }
  }
  return mapping
}
