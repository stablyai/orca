export type NativeChatDiffLineKind = 'add' | 'del' | 'context' | 'meta'

export type NativeChatDiffLine = {
  kind: NativeChatDiffLineKind
  text: string
}

const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'str_replace', 'apply_patch'])
const MAX_DIFF_CHARS = 32_000
const DEFAULT_MAX_DIFF_LINES = 120
const DIFF_TRUNCATED_LINE: NativeChatDiffLine = {
  kind: 'meta',
  text: '… diff truncated …'
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/
// Lines that open a new file section, so any hunk before them has ended.
const FILE_SECTION_START =
  /^(?:diff |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename |copy |Binary files )/
// Markdown thematic break or YAML document separator, not a marker.
const BARE_RULE = /^(?:-{3,}|\+{3,})$/

type DiffStructure = {
  /** Lines that are structure rather than content, so they never count as add/del. */
  metaIndices: Set<number>
  /** The text carries a hunk header or `diff --git`, so it is provably a diff. */
  isStructuredDiff: boolean
}

/**
 * Locates the `--- <old>` / `+++ <new>` file headers. A bare `---`/`+++` prefix
 * is not enough to spot one: a removed line whose content began with `--`
 * (SQL/Lua `-- comment`, C `--i`) is emitted as `---<content>`. Real headers
 * always come as an adjacent pair and never appear inside a hunk.
 */
function scanDiffStructure(lines: string[]): DiffStructure {
  const metaIndices = new Set<number>()
  let isStructuredDiff = false
  let inHunk = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('@@')) {
      inHunk = true
      isStructuredDiff ||= HUNK_HEADER.test(line)
      continue
    }
    if (FILE_SECTION_START.test(line)) {
      inHunk = false
      isStructuredDiff ||= line.startsWith('diff --git ')
      continue
    }
    // Only marker lines can be a header or a rule; skip context and prose early.
    if (inHunk || !(line.startsWith('-') || line.startsWith('+'))) {
      continue
    }
    if (BARE_RULE.test(line)) {
      metaIndices.add(index)
      continue
    }
    if (line.startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ')) {
      metaIndices.add(index)
      metaIndices.add(index + 1)
      index += 1
    }
  }
  return { metaIndices, isStructuredDiff }
}

function toLines(value: unknown, maxLines: number): { lines: string[]; truncated: boolean } {
  if (typeof value !== 'string') {
    return { lines: [], truncated: false }
  }
  const clipped = value.slice(0, MAX_DIFF_CHARS)
  const lines = clipped.split('\n', maxLines + 1)
  const truncated = value.length > MAX_DIFF_CHARS || lines.length > maxLines
  const bounded = lines.slice(0, maxLines)
  if (!truncated && bounded.at(-1) === '') {
    bounded.pop()
  }
  return { lines: bounded, truncated }
}

export function diffFromToolCall(
  name: string,
  input: unknown,
  maxLines = DEFAULT_MAX_DIFF_LINES
): NativeChatDiffLine[] | null {
  if (!EDIT_TOOL_NAMES.has(name) || typeof input !== 'object' || input === null) {
    return null
  }
  const value = input as Record<string, unknown>
  const oldLines = toLines(value.old_string ?? value.oldString ?? value.old, maxLines)
  const newLines = toLines(
    value.new_string ?? value.newString ?? value.new ?? value.content ?? value.file_text,
    maxLines
  )
  const deleted = oldLines.lines.map((text): NativeChatDiffLine => ({ kind: 'del', text }))
  const added = newLines.lines.map((text): NativeChatDiffLine => ({ kind: 'add', text }))
  if (deleted.length === 0 && added.length === 0) {
    return null
  }
  const path = value.file_path ?? value.path
  const prefix: NativeChatDiffLine[] =
    typeof path === 'string' ? [{ kind: 'meta', text: path }] : []
  const combined = [...prefix, ...deleted, ...added]
  const truncated = oldLines.truncated || newLines.truncated || combined.length > maxLines
  return truncated ? [...combined.slice(0, maxLines - 1), DIFF_TRUNCATED_LINE] : combined
}

export function diffFromText(
  text: string,
  maxLines = DEFAULT_MAX_DIFF_LINES
): NativeChatDiffLine[] | null {
  if (text.length === 0) {
    return null
  }
  const bounded = toLines(text, maxLines)
  const { metaIndices, isStructuredDiff } = scanDiffStructure(bounded.lines)
  let added = 0
  let removed = 0
  const lines = bounded.lines.map((line, index): NativeChatDiffLine => {
    if (
      metaIndices.has(index) ||
      line.startsWith('@@') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    ) {
      return { kind: 'meta', text: line }
    }
    if (line.startsWith('+')) {
      added += 1
      return { kind: 'add', text: line.slice(1) }
    }
    if (line.startsWith('-')) {
      removed += 1
      return { kind: 'del', text: line.slice(1) }
    }
    return { kind: 'context', text: line }
  })
  // Proven diff text renders a single-line change; without that proof, two
  // markers guard against colouring prose that merely opens a line with `-`.
  if (added + removed < (isStructuredDiff ? 1 : 2)) {
    return null
  }
  return bounded.truncated ? [...lines.slice(0, maxLines - 1), DIFF_TRUNCATED_LINE] : lines
}
