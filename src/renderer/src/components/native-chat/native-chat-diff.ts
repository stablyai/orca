// Why: transcript payloads are provider-controlled and may contain complete
// files. Diff projection is bounded before splitting so collapsed chat stays cheap.

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta'

export type DiffLine = {
  kind: DiffLineKind
  text: string
}

export type NativeChatDiffProjection = {
  lines: DiffLine[]
  source: 'synthetic' | 'unified'
  truncated: boolean
}

export type NativeChatDiffLimits = {
  maxChars?: number
  maxLines?: number
}

export const DEFAULT_NATIVE_CHAT_DIFF_MAX_CHARS = 32_000
export const DEFAULT_NATIVE_CHAT_DIFF_MAX_LINES = 400

const EDIT_TOOL_NAMES = new Set(['edit', 'multiedit', 'write', 'strreplace', 'applypatch'])

function normalizedToolName(name: string): string {
  const leaf = name.trim().split(/[.:/]/).at(-1) ?? ''
  return leaf.toLowerCase().replace(/[-_\s]/g, '')
}

function resolvedLimits(limits: NativeChatDiffLimits): { maxChars: number; maxLines: number } {
  return {
    maxChars: Math.max(1, limits.maxChars ?? DEFAULT_NATIVE_CHAT_DIFF_MAX_CHARS),
    maxLines: Math.max(1, limits.maxLines ?? DEFAULT_NATIVE_CHAT_DIFF_MAX_LINES)
  }
}

function boundedTextLines(
  value: unknown,
  maxChars: number,
  maxLines: number
): { lines: string[]; truncated: boolean } {
  if (typeof value !== 'string') {
    return { lines: [], truncated: false }
  }
  const text = value.slice(0, maxChars).replace(/\r\n/g, '\n').replace(/\n$/, '')
  const split = text ? text.split('\n') : []
  return {
    lines: split.slice(0, maxLines),
    truncated: value.length > maxChars || split.length > maxLines
  }
}

/** A bounded before/after projection. It is intentionally marked synthetic so
 * callers do not present its line totals as repository diff statistics. */
export function projectDiffFromToolCall(
  name: string,
  input: unknown,
  limits: NativeChatDiffLimits = {}
): NativeChatDiffProjection | null {
  if (!EDIT_TOOL_NAMES.has(normalizedToolName(name)) || !input || typeof input !== 'object') {
    return null
  }
  const { maxChars, maxLines } = resolvedLimits(limits)
  const obj = input as Record<string, unknown>
  const oldText = obj.old_string ?? obj.oldString ?? obj.old
  const newText = obj.new_string ?? obj.newString ?? obj.new ?? obj.content ?? obj.file_text
  const hasOld = typeof oldText === 'string'
  const hasNew = typeof newText === 'string'
  if (!hasOld && !hasNew) {
    return null
  }

  const path = obj.file_path ?? obj.filePath ?? obj.path
  const meta: DiffLine[] =
    typeof path === 'string' && path
      ? [{ kind: 'meta', text: path.slice(0, Math.min(maxChars, 4096)) }]
      : []
  const contentLineLimit = Math.max(1, maxLines - meta.length)
  const oldCharLimit = hasOld && hasNew ? Math.floor(maxChars / 2) : maxChars
  const newCharLimit = hasOld && hasNew ? maxChars - oldCharLimit : maxChars
  const oldLineLimit = hasOld && hasNew ? Math.floor(contentLineLimit / 2) : contentLineLimit
  const newLineLimit = hasOld && hasNew ? contentLineLimit - oldLineLimit : contentLineLimit
  const oldPart = boundedTextLines(oldText, oldCharLimit, Math.max(1, oldLineLimit))
  const newPart = boundedTextLines(newText, newCharLimit, Math.max(1, newLineLimit))
  const lines = [
    ...meta,
    ...oldPart.lines.map((text): DiffLine => ({ kind: 'del', text })),
    ...newPart.lines.map((text): DiffLine => ({ kind: 'add', text }))
  ].slice(0, maxLines)
  if (lines.length === meta.length) {
    return null
  }
  return {
    lines,
    source: 'synthetic',
    truncated:
      oldPart.truncated ||
      newPart.truncated ||
      meta.length + oldPart.lines.length + newPart.lines.length > maxLines
  }
}

/** Parse bounded unified-diff-looking text. Strong diff headers allow a
 * one-line change; unframed prose still needs two +/- lines to avoid false hits. */
export function projectDiffFromText(
  text: string,
  limits: NativeChatDiffLimits = {}
): NativeChatDiffProjection | null {
  if (!text) {
    return null
  }
  const { maxChars, maxLines } = resolvedLimits(limits)
  const bounded = text.slice(0, maxChars).replace(/\r\n/g, '\n')
  const raw = bounded.split('\n')
  const selected = raw.slice(0, maxLines)
  let added = 0
  let removed = 0
  let strongHeader = false
  const lines = selected.map((line): DiffLine => {
    if (
      line.startsWith('@@') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      /^\*\*\* (?:Add|Update|Delete) File: /.test(line)
    ) {
      strongHeader = true
      return { kind: 'meta', text: line }
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      strongHeader = true
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
  if (added + removed < (strongHeader ? 1 : 2)) {
    return null
  }
  return {
    lines,
    source: 'unified',
    truncated: text.length > maxChars || raw.length > maxLines
  }
}

/** Compatibility wrappers for callers that only need lines. */
export function diffFromToolCall(name: string, input: unknown): DiffLine[] | null {
  return projectDiffFromToolCall(name, input)?.lines ?? null
}

export function diffFromText(text: string): DiffLine[] | null {
  return projectDiffFromText(text)?.lines ?? null
}
