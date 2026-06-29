// Why: agent edits show up as tool calls (Edit/Write with old/new strings) and
// tool results that contain unified-diff text. The chat renders these as inline
// coloured diffs like the terminal, so detection/parsing is pure and testable.
// Ported from the mobile diffFromToolCall/diffFromText (desktop parity).

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta'

export type DiffLine = {
  kind: DiffLineKind
  text: string
}

const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'str_replace', 'apply_patch'])

function toLines(value: unknown): string[] {
  return typeof value === 'string' ? value.replace(/\n$/, '').split('\n') : []
}

/** Build diff lines from an Edit-style tool call input (old_string/new_string),
 *  or null when the input isn't an editing payload. Old lines render as deletes,
 *  new lines as adds — a simple, readable before/after rather than a full LCS. */
export function diffFromToolCall(name: string, input: unknown): DiffLine[] | null {
  if (!EDIT_TOOL_NAMES.has(name) || typeof input !== 'object' || input === null) {
    return null
  }
  const obj = input as Record<string, unknown>
  const oldText = obj.old_string ?? obj.oldString ?? obj.old
  const newText = obj.new_string ?? obj.newString ?? obj.new ?? obj.content ?? obj.file_text
  const dels = toLines(oldText).map((text): DiffLine => ({ kind: 'del', text }))
  const adds = toLines(newText).map((text): DiffLine => ({ kind: 'add', text }))
  if (dels.length === 0 && adds.length === 0) {
    return null
  }
  const lines: DiffLine[] = []
  if (typeof obj.file_path === 'string' || typeof obj.path === 'string') {
    lines.push({ kind: 'meta', text: String(obj.file_path ?? obj.path) })
  }
  return [...lines, ...dels, ...adds]
}

/** Parse unified-diff-looking text into coloured lines, or null when the text
 *  doesn't read as a diff (no +/- lines). */
export function diffFromText(text: string): DiffLine[] | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null
  }
  const raw = text.split('\n')
  let added = 0
  let removed = 0
  const lines: DiffLine[] = raw.map((line): DiffLine => {
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) {
      return { kind: 'meta', text: line }
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++
      return { kind: 'add', text: line.slice(1) }
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      removed++
      return { kind: 'del', text: line.slice(1) }
    }
    return { kind: 'context', text: line }
  })
  // Require a meaningful amount of diff signal so ordinary prose isn't mistaken
  // for a diff (a stray leading '-' bullet shouldn't trigger diff rendering).
  if (added + removed < 2) {
    return null
  }
  return lines
}
