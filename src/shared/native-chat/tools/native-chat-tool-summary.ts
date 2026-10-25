import {
  collapsedToolInputPrefix,
  unwrapLoginShellCommand,
  MAX_TOOL_PREVIEW_LENGTH
} from './native-chat-tool-preview-prefix'
import type { NativeChatMcpIdentity } from './native-chat-tool-identity'
import { isToolCallBlock, type NativeChatBlock } from '../../native-chat-types'

const MAX_PREVIEW_STRING_INPUT = 160
const MAX_PREVIEW_COLLECTION_ITEMS = 8
const MAX_PREVIEW_DEPTH = 2
const MAX_TOOL_RUN_SUMMARY_PARTS = 3
// Prefer search term over command when classified rows carry both. directory labels scans/listings but is not an open-file target:
// mobile would offer a dead file link to that folder.
const PRIMARY_ARG_KEYS = [
  'query',
  'pattern',
  'directory',
  'command',
  'cmd',
  'url',
  'description'
] as const
const BRIEF_ARG_KEYS = ['query', 'pattern', 'directory', 'command', 'cmd'] as const
const COMMAND_ARG_KEYS = ['command', 'cmd'] as const
export const MAX_TOOL_DETAIL_LENGTH = 4000

export type ToolInputDisplay = {
  label: string
  filePath: string | null
  hasDetail: boolean
  formatDetail: () => string
}

export function summarizeToolInput(input: unknown): string {
  // Strip shell wrappers before clipping because their closing quote proves the match.
  const collapsed = collapsedToolInputPrefix(unwrapLoginShellCommand(toRawPreview(input)))
  return collapsed.length <= MAX_TOOL_PREVIEW_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_TOOL_PREVIEW_LENGTH - 1)}…`
}

/** Normalize row display once; format details lazily because collapsed mobile rows never need them. */
export function createToolInputDisplay(input: unknown): ToolInputDisplay {
  const normalized = normalizeToolInput(input)
  const filePath = normalizedToolFilePath(normalized)
  const label = describeNormalizedToolInput(normalized, filePath)
  return {
    label,
    filePath,
    hasDetail: normalizedToolInputHasDetail(normalized, label),
    formatDetail: () => truncateToolDetail(formatNormalizedToolInput(normalized))
  }
}

export function truncateToolDetail(text: string): string {
  return text.length > MAX_TOOL_DETAIL_LENGTH ? `${text.slice(0, MAX_TOOL_DETAIL_LENGTH)}…` : text
}

/** Prefer target path, then primary string argument, then bounded JSON; keep serialized file_path objects out of tappable labels. */
export function describeToolInput(input: unknown): string {
  const normalized = normalizeToolInput(input)
  return describeNormalizedToolInput(normalized, normalizedToolFilePath(normalized))
}

function describeNormalizedToolInput(input: unknown, path: string | null): string {
  if (path) {
    return summarizeToolPath(path)
  }
  if (input && typeof input === 'object') {
    // Concrete target/action first; prose `description` only as a last resort.
    const primary = firstPrimaryToolArg(input as Record<string, unknown>, PRIMARY_ARG_KEYS)
    if (primary) {
      return primary
    }
  }
  return summarizeToolInput(input)
}

/** Pretty-print structured JSON/arrays for expanded detail; retain ordinary prose strings. */
export function formatToolInput(input: unknown): string {
  return formatNormalizedToolInput(normalizeToolInput(input))
}

function formatNormalizedToolInput(input: unknown): string {
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

function isStructuredNormalizedToolInput(input: unknown): boolean {
  if (input === null || typeof input !== 'object') {
    return false
  }
  // Empty inputs repeat the label without detail; do not offer a redundant expander.
  return Array.isArray(input) ? input.length > 0 : Object.keys(input).length > 0
}

function normalizedToolInputHasDetail(input: unknown, label: string): boolean {
  if (isStructuredNormalizedToolInput(input)) {
    return true
  }
  return typeof input === 'string' && collapsedToolInputPrefix(input) !== label
}

export function toolFilePath(input: unknown): string | null {
  return normalizedToolFilePath(normalizeToolInput(input))
}

function normalizedToolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const value = input as Record<string, unknown>
  // Search path is usually a scan root. Suppress file links, accepting lost file-scoped links over dead folder links on most searches.
  const directory = isSearchToolInput(value) ? undefined : value.path
  const path =
    value.file_path ??
    value.filePath ??
    directory ??
    value.notebook_path ??
    firstPatchChangePath(value)
  return typeof path === 'string' && path.length > 0 ? path : null
}

function firstPatchChangePath(value: Record<string, unknown>): unknown {
  if (!Array.isArray(value.changes)) {
    return undefined
  }
  for (const change of value.changes) {
    if (typeof change === 'object' && change !== null && typeof change.path === 'string') {
      return change.path
    }
  }
  return undefined
}

export function briefToolArg(input: unknown): string {
  const normalized = normalizeToolInput(input)
  if (normalized && typeof normalized === 'object') {
    const path = toolFilePath(normalized)
    if (path) {
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.at(-1) ?? path
    }
    const value = normalized as Record<string, unknown>
    const command = firstPrimaryToolArg(value, BRIEF_ARG_KEYS)
    if (command) {
      return command.slice(0, 28)
    }
    // Blank string arguments mean no brief text, not raw JSON fallback; populated structured values still receive previews.
    if (BRIEF_ARG_KEYS.some((key) => typeof value[key] === 'string')) {
      return ''
    }
  }
  return summarizeToolInput(normalized).slice(0, 28)
}

/** Raw shell command distinguishes Codex classified read/search/list from same-named Claude tools. */
export function toolInputCommand(input: unknown): string | null {
  const normalized = normalizeToolInput(input)
  return isToolInputRecord(normalized) ? firstPrimaryToolArg(normalized, COMMAND_ARG_KEYS) : null
}

function isToolInputRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Decode Codex JSON-string arguments for structural readers; retain prose strings. */
export function normalizeToolInput(input: unknown): unknown {
  if (typeof input !== 'string') {
    return input
  }
  const first = input.trimStart()[0]
  if (first !== '{' && first !== '[') {
    return input
  }
  try {
    const parsed: unknown = JSON.parse(input)
    return parsed !== null && typeof parsed === 'object' ? parsed : input
  } catch {
    return input
  }
}

function isSearchToolInput(value: Record<string, unknown>): boolean {
  return (
    summarizePrimaryToolArg(value.query) !== null || summarizePrimaryToolArg(value.pattern) !== null
  )
}

/** Skip blank keys so later populated arguments remain eligible labels. */
function firstPrimaryToolArg(
  value: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const summary = summarizePrimaryToolArg(value[key])
    if (summary) {
      return summary
    }
  }
  return null
}

/** Trim paths from the front to preserve the distinguishing basename. */
function summarizeToolPath(path: string): string {
  const collapsed = path.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_TOOL_PREVIEW_LENGTH) {
    return collapsed
  }
  const tail = collapsed.slice(collapsed.length - (MAX_TOOL_PREVIEW_LENGTH - 1))
  // Start at a segment boundary so the label doesn't open mid-name.
  const boundary = tail.search(/[\\/]/)
  return `…${boundary > 0 ? tail.slice(boundary) : tail}`
}

/** A label-worthy primary argument: a non-blank string, or an argv array. */
function summarizePrimaryToolArg(input: unknown): string | null {
  if (typeof input === 'string' && input.trim()) {
    return summarizeToolInput(input)
  }
  if (Array.isArray(input) && input.length > 0 && input.every((part) => typeof part === 'string')) {
    return summarizeToolInput(input.join(' '))
  }
  return null
}

/** Separate run members let surfaces draw their own boundaries. */
export type ToolRunMember = {
  name: string
  /** Brief argument, or '' when the call has none worth showing. */
  arg: string
  mcpIdentity?: NativeChatMcpIdentity
}

/** Share the joined header’s leading-call cap so structured members describe the same run. */
export function toolRunSummaryMembers(blocks: readonly NativeChatBlock[]): ToolRunMember[] {
  const members: ToolRunMember[] = []
  for (const block of blocks) {
    if (!isToolCallBlock(block)) {
      continue
    }
    const name = block.name.trim()
    if (!name) {
      continue
    }
    members.push({ name, arg: briefToolArg(block.input), mcpIdentity: block.mcpIdentity })
    if (members.length >= MAX_TOOL_RUN_SUMMARY_PARTS) {
      break
    }
  }
  return members
}

export function summarizeToolRun(blocks: readonly NativeChatBlock[]): string {
  return toolRunSummaryMembers(blocks)
    .map((member) => (member.arg ? `${member.name} ${member.arg}` : member.name))
    .join('  ·  ')
}

export function countToolCalls(blocks: readonly NativeChatBlock[]): number {
  let count = 0
  blocks.forEach((block) => {
    if (isToolCallBlock(block)) {
      count += 1
    }
  })
  return count
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
    if (!Object.hasOwn(value, key)) {
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
