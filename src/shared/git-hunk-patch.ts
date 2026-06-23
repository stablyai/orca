// Parse a single-file unified diff into hunks and rebuild a minimal patch from a
// selection. Hunks are kept verbatim so the result applies with `git apply` as-is.

export type DiffHunk = {
  /** 0-based position within the file diff. Stable id for selection. */
  index: number
  /** The `@@ -a,b +c,d @@ …` line, kept verbatim. */
  header: string
  /** Body lines (context/+/-/`\ No newline`), without line terminators. */
  lines: string[]
  /** 1-based start line on the new (modified) side — the UI anchor. */
  newStart: number
  newLineCount: number
  oldStart: number
  oldLineCount: number
}

export type ParsedFileDiff = {
  /** Lines before the first hunk: `diff --git`, `index`, `---`, `+++`. */
  headerLines: string[]
  hunks: DiffHunk[]
  /** Binary or rename-only diffs have no textual hunks to stage per-hunk. */
  isBinary: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function isHunkBodyLine(line: string): boolean {
  if (line.length === 0) {
    // Why: git emits a bare empty line for an unchanged blank context line
    // (the leading space is dropped). It still belongs to the current hunk.
    return true
  }
  const c = line.at(0)
  return c === ' ' || c === '+' || c === '-' || c === '\\'
}

/**
 * Parse a single-file unified diff. Splits on `\n` only so CRLF content lines
 * keep their `\r` and round-trip byte-for-byte through {@link buildHunkPatch}.
 */
export function parseFileDiff(patchText: string): ParsedFileDiff {
  const empty: ParsedFileDiff = { headerLines: [], hunks: [], isBinary: false }
  if (!patchText) {
    return empty
  }
  const lines = patchText.split('\n')
  // Why: a trailing newline produces a final empty element that is not part of
  // the diff; drop it so it doesn't get re-added as spurious content.
  if (lines.at(-1) === '') {
    lines.pop()
  }

  const headerLines: string[] = []
  let i = 0
  let isBinary = false
  while (i < lines.length && !HUNK_HEADER.test(lines[i])) {
    if (lines[i].startsWith('Binary files ') || lines[i].startsWith('GIT binary patch')) {
      isBinary = true
    }
    headerLines.push(lines[i])
    i++
  }

  const hunks: DiffHunk[] = []
  while (i < lines.length) {
    const match = HUNK_HEADER.exec(lines[i])
    if (!match) {
      break
    }
    const header = lines[i]
    i++
    const body: string[] = []
    while (i < lines.length && !HUNK_HEADER.test(lines[i]) && isHunkBodyLine(lines[i])) {
      body.push(lines[i])
      i++
    }
    hunks.push({
      index: hunks.length,
      header,
      lines: body,
      oldStart: Number(match[1]),
      oldLineCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLineCount: match[4] === undefined ? 1 : Number(match[4])
    })
  }

  return { headerLines, hunks, isBinary }
}

/**
 * Rebuild a patch containing only the selected hunks. The file header is kept
 * intact; each selected hunk is emitted verbatim, so `git apply --cached`
 * accepts it without `--recount`. Returns `''` when nothing applies.
 */
export function buildHunkPatch(parsed: ParsedFileDiff, selectedIndexes: readonly number[]): string {
  if (parsed.headerLines.length === 0 || selectedIndexes.length === 0) {
    return ''
  }
  const wanted = new Set(selectedIndexes)
  const selected = parsed.hunks.filter((hunk) => wanted.has(hunk.index))
  if (selected.length === 0) {
    return ''
  }
  const out: string[] = [...parsed.headerLines]
  for (const hunk of selected) {
    out.push(hunk.header, ...hunk.lines)
  }
  // Why: git apply rejects a patch whose final hunk line lacks a terminator.
  return `${out.join('\n')}\n`
}

const DIFF_GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/

function diffPatchPaths(patchText: string): string[] {
  const paths = new Set<string>()
  for (const line of patchText.split('\n')) {
    const match = DIFF_GIT_HEADER.exec(line)
    if (match) {
      paths.add(match[1])
      paths.add(match[2])
    }
  }
  return [...paths]
}

/** True when `patch` only touches `filePath` — guards `git apply --cached`
 * against a patch that would stage unrelated repo paths. */
export function patchTouchesOnlyPath(patchText: string, filePath: string): boolean {
  const want = filePath.replace(/\\/g, '/')
  const paths = diffPatchPaths(patchText)
  return paths.length > 0 && paths.every((path) => path === want)
}
