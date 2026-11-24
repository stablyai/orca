// GitHub ends a review comment's diff hunk on the line the thread is anchored to, so its tail is the code in question.

const HUNK_TAIL_LINES = 8

/** The hunk's last lines without its @@ header; what the host forwards so phones get the code, not the whole hunk. */
export function tailDiffHunk(hunk: string | null | undefined): string | undefined {
  if (!hunk) {
    return undefined
  }
  const lines = hunk.split('\n').filter((line) => !line.startsWith('@@'))
  return lines.length > 0 ? lines.slice(-HUNK_TAIL_LINES).join('\n') : undefined
}

export type DiffHunkLine = {
  /** Position in the hunk tail; stable and unique, for list keys. */
  index: number
  number: number | null
  sign: '+' | '-' | ' '
  text: string
}

/**
 * The lines a thread is about (startLine..endLine, or just endLine), numbered back from endLine.
 * Removed lines inside the range show unnumbered; "\ No newline" markers are skipped.
 */
export function threadDiffLines(
  hunkTail: string,
  endLine: number,
  startLine?: number
): DiffHunkLine[] {
  const first = Math.max(startLine ?? endLine, endLine - HUNK_TAIL_LINES + 1)
  const lines = hunkTail.split('\n')
  const out: DiffHunkLine[] = []
  let number = endLine
  for (let index = lines.length - 1; index >= 0 && number >= first; index--) {
    const raw = lines[index]
    if (raw.startsWith('\\')) {
      continue
    }
    const sign = raw.startsWith('+') ? '+' : raw.startsWith('-') ? '-' : ' '
    const text = sign === ' ' && !raw.startsWith(' ') ? raw : raw.slice(1)
    if (sign === '-') {
      out.unshift({ index, number: null, sign, text })
      continue
    }
    out.unshift({ index, number, sign, text })
    number -= 1
  }
  return out
}
