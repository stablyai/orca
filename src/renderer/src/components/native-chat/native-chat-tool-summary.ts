// Why: tool-call inputs are arbitrary JSON; the chat row only shows a one-line
// preview so a long file body or diff doesn't dominate the conversation. Kept
// pure so the truncation/serialization rules are unit-testable. Ported from the
// mobile summarizeToolInput/summarizeToolRun (desktop parity).

import { basename } from '../../lib/path'
import { isToolCallBlock, type NativeChatBlock } from '../../../../shared/native-chat-types'

const MAX_PREVIEW_LENGTH = 80

/** One-line, length-capped preview of a tool-call input payload. Strings pass
 *  through; objects/arrays serialize to compact JSON; everything collapses
 *  whitespace and truncates with an ellipsis. Returns '' when there's nothing
 *  worth showing. */
export function summarizeToolInput(input: unknown): string {
  const raw = toRawPreview(input)
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_PREVIEW_LENGTH) {
    return collapsed
  }
  return `${collapsed.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
}

/** Full, pretty-printed tool-call input for the expanded detail view. Strings
 *  pass through as-is; objects/arrays print as indented JSON so a diff-less call
 *  (e.g. a question payload) reads cleanly instead of one long minified line. */
export function formatToolInput(input: unknown): string {
  if (input === null || input === undefined) {
    return ''
  }
  if (typeof input === 'string') {
    return input
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input)
  }
  try {
    return JSON.stringify(input, null, 2) ?? ''
  } catch {
    return ''
  }
}

/** A very short hint for a tool call in a one-line run summary: the target file's
 *  basename when present, else a clipped preview of the input. */
export function briefToolArg(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const path = obj.file_path ?? obj.path ?? obj.notebook_path
    if (typeof path === 'string' && path.length > 0) {
      return basename(path)
    }
    const cmd = obj.command ?? obj.cmd ?? obj.query ?? obj.pattern
    if (typeof cmd === 'string') {
      return summarizeToolInput(cmd).slice(0, 28)
    }
  }
  return summarizeToolInput(input).slice(0, 28)
}

/** One-line summary of a run of tool calls: "Bash git status · Edit app.tsx · …".
 *  Only tool-call blocks contribute names; results are skipped. */
export function summarizeToolRun(blocks: readonly NativeChatBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (!isToolCallBlock(block)) {
      continue
    }
    const name = block.name.trim()
    // Skip nameless tool calls so the join can't produce orphan separators
    // ("Tool  ·  ·").
    if (!name) {
      continue
    }
    const brief = briefToolArg(block.input)
    parts.push(brief ? `${name} ${brief}` : name)
  }
  return parts.join('  ·  ')
}

/** Count the tool calls in a run (used for the "N tool calls" fold label). */
export function countToolCalls(blocks: readonly NativeChatBlock[]): number {
  return blocks.filter(isToolCallBlock).length
}

function toRawPreview(input: unknown): string {
  if (input === null || input === undefined) {
    return ''
  }
  if (typeof input === 'string') {
    return input
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input)
  }
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}
