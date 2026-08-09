/** A contiguous run of changed lines, addressed in CURRENT-buffer line numbers (1-based). */
export type GitGutterHunk =
  | { kind: 'added'; startLine: number; endLine: number }
  | { kind: 'modified'; startLine: number; endLine: number }
  /** Lines were removed directly after `afterLine`. 0 means removed above line 1. */
  | { kind: 'deleted'; afterLine: number }

// Why: Myers' trace is O(d^2) memory. Past this the file was rewritten wholesale, where
// per-line marks are noise anyway — bail instead of painting the whole gutter.
export const GIT_GUTTER_MAX_EDIT_DISTANCE = 2000

type EditOp = { type: 'delete'; aIndex: number } | { type: 'insert'; bIndex: number }

/** Matches Monaco's `model.getLinesContent()` so both sides of the diff line up. */
export function splitGitGutterLines(text: string): string[] {
  return text.split(/\r?\n/)
}

function backtrack(
  trace: readonly Int32Array[],
  offset: number,
  aLength: number,
  bLength: number
): EditOp[] {
  const ops: EditOp[] = []
  let x = aLength
  let y = bLength

  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d - 1]!
    const k = x - y
    const takeRight = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
    const previousK = takeRight ? k + 1 : k - 1
    const previousX = v[offset + previousK]!
    const previousY = previousX - previousK

    while (x > previousX && y > previousY) {
      x -= 1
      y -= 1
    }
    if (x > previousX) {
      x -= 1
      ops.push({ type: 'delete', aIndex: x })
    } else if (y > previousY) {
      y -= 1
      ops.push({ type: 'insert', bIndex: y })
    }
  }

  ops.reverse()
  return ops
}

/** Myers' greedy diff. Returns null when the edit distance exceeds the cap. */
function computeEditScript(a: readonly string[], b: readonly string[]): EditOp[] | null {
  const aLength = a.length
  const bLength = b.length
  const max = Math.min(aLength + bLength, GIT_GUTTER_MAX_EDIT_DISTANCE)
  const offset = aLength + bLength
  const v = new Int32Array(2 * (aLength + bLength) + 1)
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const takeRight = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
      let x = takeRight ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < aLength && y < bLength && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= aLength && y >= bLength) {
        trace.push(v.slice())
        return backtrack(trace, offset, aLength, bLength)
      }
    }
    trace.push(v.slice())
  }

  return null
}

function toHunks(ops: readonly EditOp[]): GitGutterHunk[] {
  const hunks: GitGutterHunk[] = []
  let aIndex = 0
  let bIndex = 0
  let groupStartLine = 0
  let inserted = 0
  let deleted = 0

  const closeGroup = (): void => {
    if (inserted === 0 && deleted === 0) {
      return
    }
    if (inserted === 0) {
      hunks.push({ kind: 'deleted', afterLine: groupStartLine })
    } else {
      hunks.push({
        kind: deleted === 0 ? 'added' : 'modified',
        startLine: groupStartLine + 1,
        endLine: groupStartLine + inserted
      })
    }
    inserted = 0
    deleted = 0
  }

  for (const op of ops) {
    const skipped = op.type === 'delete' ? op.aIndex - aIndex : op.bIndex - bIndex
    if (skipped > 0) {
      closeGroup()
      aIndex += skipped
      bIndex += skipped
    }
    if (inserted === 0 && deleted === 0) {
      groupStartLine = bIndex
    }
    if (op.type === 'delete') {
      aIndex += 1
      deleted += 1
    } else {
      bIndex += 1
      inserted += 1
    }
  }
  closeGroup()

  return hunks
}

// Why: `''.split(/\r?\n/)` yields `['']`, Monaco's own encoding of a zero-byte file — it
// carries no real content, so treat it as zero lines rather than one line to diff against.
function withoutPhantomEmptyLine(lines: readonly string[]): readonly string[] {
  return lines.length === 1 && lines[0] === '' ? [] : lines
}

export function computeGitGutterHunks(
  rawBaseLines: readonly string[],
  rawCurrentLines: readonly string[]
): GitGutterHunk[] {
  const baseLines = withoutPhantomEmptyLine(rawBaseLines)
  const currentLines = withoutPhantomEmptyLine(rawCurrentLines)

  // Why: real edits touch a handful of lines, so trimming the shared head and tail keeps
  // Myers' search space proportional to the edit, not the file.
  let prefix = 0
  const shortest = Math.min(baseLines.length, currentLines.length)
  while (prefix < shortest && baseLines[prefix] === currentLines[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < shortest - prefix &&
    baseLines[baseLines.length - suffix - 1] === currentLines[currentLines.length - suffix - 1]
  ) {
    suffix += 1
  }

  const baseMiddle = baseLines.slice(prefix, baseLines.length - suffix)
  const currentMiddle = currentLines.slice(prefix, currentLines.length - suffix)
  if (baseMiddle.length === 0 && currentMiddle.length === 0) {
    return []
  }

  const ops = computeEditScript(baseMiddle, currentMiddle)
  if (!ops) {
    return []
  }

  return toHunks(ops).map((hunk) =>
    hunk.kind === 'deleted'
      ? { ...hunk, afterLine: hunk.afterLine + prefix }
      : { ...hunk, startLine: hunk.startLine + prefix, endLine: hunk.endLine + prefix }
  )
}
