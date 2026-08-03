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
  const raw = bounded.lines
  let added = 0
  let removed = 0
  const lines = raw.map((line, i): NativeChatDiffLine => {
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) {
      return { kind: 'meta', text: line }
    }
    // Why: `--- <old>`/`+++ <new>` file headers always carry a trailing space + path and
    // travel as a consecutive pair. A deletion of `-- comment` (SQL/Lua/Haskell) is emitted
    // by git as `---<content>` (no space) — match the canonical separator pair, not a lone
    // prefix, so it counts as a deletion (agent-tool diffs may lack the `@@` countDiffLines relies on).
    const isHeaderPair =
      (line.startsWith('--- ') && raw[i + 1]?.startsWith('+++ ')) ||
      (line.startsWith('+++ ') && i > 0 && raw[i - 1].startsWith('--- '))
    if (isHeaderPair) {
      return { kind: 'context', text: line }
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
  if (added + removed < 2) {
    return null
  }
  return bounded.truncated ? [...lines.slice(0, maxLines - 1), DIFF_TRUNCATED_LINE] : lines
}
