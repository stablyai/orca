import type { AiVaultRgSearchScope } from './ai-vault-session-search-scope'

const TOOL_ITEM_TYPES = new Set([
  'tool_use',
  'tool_result',
  'tool-use',
  'tool-result',
  'tooluse',
  'toolresult',
  'tooluseresult',
  'tool_use_result',
  'function_call',
  'functioncall',
  'function_call_output',
  'function_result',
  'functionresult'
])

const USER_TYPES = new Set(['user', 'user.message', 'user_message', 'human', 'human_message'])

const ASSISTANT_TYPES = new Set(['assistant', 'assistant.message', 'agent_message', 'ai', 'model'])

const ERROR_TYPES = new Set([
  'error',
  'exception',
  'failure',
  'fatal',
  'stream_error',
  'agent_error',
  'api_error',
  'rate_limit',
  'ratelimit'
])

const ERROR_TEXT_RE = /\b(error|failed|failure|fatal|crash|exception|rate[\s_-]?limit)\b/i

export type TranscriptScopeTexts = {
  user: string
  assistant: string
  tool: string
  error: string
  prose: string
}

export function collectTranscriptScopeTexts(record: unknown): TranscriptScopeTexts {
  const empty: TranscriptScopeTexts = {
    user: '',
    assistant: '',
    tool: '',
    error: '',
    prose: ''
  }
  const root = asRecord(record)
  if (!root) {
    return empty
  }

  const typeHint = recordTypeHint(root)
  const payload = asRecord(root.payload) ?? asRecord(root.data) ?? asRecord(root.message) ?? root
  const collected = collectFromNode(payload, typeHint)
  if (typeHint === 'error' || looksLikeErrorRecord(root) || looksLikeErrorRecord(payload)) {
    collected.error = joinScopedText(collected.error, collectAllText(payload))
  }
  collected.prose = joinScopedText(collected.user, collected.assistant)
  return collected
}

export function transcriptRecordMatchesSearchScope(
  record: unknown,
  query: string,
  searchScope: AiVaultRgSearchScope
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return false
  }
  const texts = collectTranscriptScopeTexts(record)
  switch (searchScope) {
    case 'full':
      return collectAllText(record).toLowerCase().includes(needle)
    case 'fullWithoutTools':
      return texts.prose.toLowerCase().includes(needle)
    case 'user':
      return texts.user.toLowerCase().includes(needle)
    case 'assistant':
      return texts.assistant.toLowerCase().includes(needle)
    case 'errors':
      return texts.error.toLowerCase().includes(needle)
  }
}

export function transcriptLineMatchesSearchScope(
  line: string,
  query: string,
  searchScope: AiVaultRgSearchScope
): boolean {
  const trimmed = line.trim()
  if (!trimmed) {
    return false
  }
  try {
    return transcriptRecordMatchesSearchScope(JSON.parse(trimmed) as unknown, query, searchScope)
  } catch {
    if (searchScope === 'full') {
      return trimmed.toLowerCase().includes(query.trim().toLowerCase())
    }
    if (searchScope === 'errors') {
      return (
        ERROR_TEXT_RE.test(trimmed) && trimmed.toLowerCase().includes(query.trim().toLowerCase())
      )
    }
    return false
  }
}

function collectFromNode(value: unknown, inheritedRole: ScopeRole): TranscriptScopeTexts {
  const texts: TranscriptScopeTexts = {
    user: '',
    assistant: '',
    tool: '',
    error: '',
    prose: ''
  }
  if (typeof value === 'string') {
    appendRoleText(texts, inheritedRole, value)
    return texts
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      mergeTexts(texts, collectFromNode(item, inheritedRole))
    }
    return texts
  }
  const record = asRecord(value)
  if (!record) {
    return texts
  }

  const itemType = normalizedType(record.type ?? record.kind)
  if (itemType && TOOL_ITEM_TYPES.has(itemType)) {
    appendRoleText(texts, 'tool', collectAllText(record))
    return texts
  }

  const role = resolveRole(record, inheritedRole)
  if (record.content !== undefined) {
    mergeTexts(texts, collectFromNode(record.content, role))
  }
  if (record.message !== undefined && record.message !== record.content) {
    mergeTexts(texts, collectFromNode(record.message, role))
  }
  if (typeof record.text === 'string') {
    appendRoleText(texts, role, record.text)
  }
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      mergeTexts(texts, collectFromNode(message, 'other'))
    }
  }
  if (role === 'error') {
    appendRoleText(texts, 'error', collectAllText(record))
  }
  return texts
}

type ScopeRole = 'user' | 'assistant' | 'tool' | 'error' | 'other'

function resolveRole(record: Record<string, unknown>, inherited: ScopeRole): ScopeRole {
  const typeHint = recordTypeHint(record)
  if (typeHint !== 'other') {
    return typeHint
  }
  return inherited
}

function recordTypeHint(record: Record<string, unknown>): ScopeRole {
  const typeValue = normalizedType(record.type ?? record.kind ?? record.role)
  if (!typeValue) {
    return 'other'
  }
  if (TOOL_ITEM_TYPES.has(typeValue) || typeValue.includes('tool')) {
    return 'tool'
  }
  if (USER_TYPES.has(typeValue) || typeValue.endsWith('.user')) {
    return isToolOnlyMessage(record) ? 'tool' : 'user'
  }
  if (ASSISTANT_TYPES.has(typeValue) || typeValue.endsWith('.assistant')) {
    return 'assistant'
  }
  if (ERROR_TYPES.has(typeValue) || typeValue.includes('error') || typeValue.includes('fail')) {
    return 'error'
  }
  return 'other'
}

function isToolOnlyMessage(record: Record<string, unknown>): boolean {
  const content = record.content ?? asRecord(record.message)?.content
  if (!Array.isArray(content) || content.length === 0) {
    return false
  }
  return content.every((item) => {
    const itemRecord = asRecord(item)
    const itemType = normalizedType(itemRecord?.type ?? itemRecord?.kind)
    return Boolean(itemType && TOOL_ITEM_TYPES.has(itemType))
  })
}

function looksLikeErrorRecord(record: Record<string, unknown>): boolean {
  if (record.isApiErrorMessage === true || record.is_error === true) {
    return true
  }
  const typeValue = normalizedType(record.type ?? record.kind ?? record.level)
  return Boolean(typeValue && (ERROR_TYPES.has(typeValue) || typeValue.includes('error')))
}

function appendRoleText(texts: TranscriptScopeTexts, role: ScopeRole, value: string): void {
  const trimmed = value.trim()
  if (!trimmed) {
    return
  }
  if (role === 'user') {
    texts.user = joinScopedText(texts.user, trimmed)
  } else if (role === 'assistant') {
    texts.assistant = joinScopedText(texts.assistant, trimmed)
  } else if (role === 'tool') {
    texts.tool = joinScopedText(texts.tool, trimmed)
  } else if (role === 'error') {
    texts.error = joinScopedText(texts.error, trimmed)
  }
}

function mergeTexts(target: TranscriptScopeTexts, extra: TranscriptScopeTexts): void {
  target.user = joinScopedText(target.user, extra.user)
  target.assistant = joinScopedText(target.assistant, extra.assistant)
  target.tool = joinScopedText(target.tool, extra.tool)
  target.error = joinScopedText(target.error, extra.error)
}

function joinScopedText(left: string, right: string): string {
  if (!left) {
    return right
  }
  if (!right) {
    return left
  }
  return `${left} ${right}`
}

function collectAllText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map(collectAllText).filter(Boolean).join(' ')
  }
  const record = asRecord(value)
  if (!record) {
    return ''
  }
  return Object.values(record).map(collectAllText).filter(Boolean).join(' ')
}

function normalizedType(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
