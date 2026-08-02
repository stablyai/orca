import { isToolCallBlock, type NativeChatBlock } from './native-chat-types'

const MAX_PREVIEW_LENGTH = 80
const MAX_PREVIEW_STRING_INPUT = 160
const MAX_PREVIEW_COLLECTION_ITEMS = 8
const MAX_PREVIEW_DEPTH = 2
const MAX_TOOL_RUN_SUMMARY_PARTS = 3

export function summarizeToolInput(input: unknown): string {
  const collapsed = toRawPreview(input).replace(/\s+/g, ' ').trim()
  return collapsed.length <= MAX_PREVIEW_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
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

export function toolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const value = input as Record<string, unknown>
  const path = value.file_path ?? value.filePath ?? value.path ?? value.notebook_path
  return typeof path === 'string' && path.length > 0 ? path : null
}

export function briefToolArg(input: unknown): string {
  if (input && typeof input === 'object') {
    const value = input as Record<string, unknown>
    const path = value.file_path ?? value.filePath ?? value.path ?? value.notebook_path
    if (typeof path === 'string' && path.length > 0) {
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.at(-1) ?? path
    }
    const command = value.command ?? value.cmd ?? value.query ?? value.pattern
    if (typeof command === 'string') {
      return summarizeToolInput(command).slice(0, 28)
    }
  }
  return summarizeToolInput(input).slice(0, 28)
}

export function summarizeToolRun(blocks: readonly NativeChatBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (!isToolCallBlock(block)) {
      continue
    }
    const name = block.name.trim()
    if (!name) {
      continue
    }
    const detail = briefToolArg(block.input)
    parts.push(detail ? `${name} ${detail}` : name)
    if (parts.length >= MAX_TOOL_RUN_SUMMARY_PARTS) {
      break
    }
  }
  return parts.join('  ·  ')
}

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
  if (typeof input !== 'object') {
    return String(input)
  }
  try {
    return JSON.stringify(boundedPreviewValue(input, 0, new WeakSet<object>())) ?? ''
  } catch {
    return ''
  }
}

function boundedPreviewValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_PREVIEW_STRING_INPUT
      ? `${value.slice(0, MAX_PREVIEW_STRING_INPUT)}…`
      : value
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[circular]'
  }
  if (depth >= MAX_PREVIEW_DEPTH) {
    return '[…]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_PREVIEW_COLLECTION_ITEMS)
      .map((item) => boundedPreviewValue(item, depth + 1, seen))
    if (value.length > MAX_PREVIEW_COLLECTION_ITEMS) {
      result.push('…')
    }
    return result
  }
  const result: Record<string, unknown> = {}
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue
    }
    if (count >= MAX_PREVIEW_COLLECTION_ITEMS) {
      result['…'] = '…'
      break
    }
    result[key] = boundedPreviewValue((value as Record<string, unknown>)[key], depth + 1, seen)
    count += 1
  }
  return result
}
