// Custom TUI agent definition-field validation: bounds, labels, env, command
// override, and args template. Fail-closed and lossless — invalid input is
// rejected with a typed issue, never silently truncated or rewritten.

import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { validateAgentArgsTemplate } from './agent-args-tokenizer'

export const MAX_AGENT_LABEL_CODE_UNITS = 80
export const MAX_COMMAND_PATH_LENGTH = 4096
export const MAX_AGENT_ARGS_CODE_UNITS = 8192
export const MAX_CUSTOM_AGENT_ENV_ENTRIES = 64
export const MAX_CUSTOM_AGENT_ENV_KEY_CODE_UNITS = 128
export const MAX_CUSTOM_AGENT_ENV_VALUE_CODE_UNITS = 4096
/** Serialized configured env bound, measured as the larger of UTF-8 bytes and
 *  Windows UTF-16 `key=value\0` code units including the final terminator. */
export const MAX_CUSTOM_AGENT_ENV_BYTES = 16_384
/** Complete UTF-8 JSON serialization bound for the local live+tombstone custom catalog. */
export const MAX_LOCAL_AGENT_CATALOG_BYTES = 16_777_216
/** Env-free remote projection bound per snapshot frame (transport caps frames at 1 MiB). */
export const MAX_AGENT_CATALOG_PROJECTION_BYTES = 524_288
/** Settings catalog search input bound (truncated at a code-point boundary before matching). */
export const AGENT_SEARCH_QUERY_MAX_BYTES = 2048

export type AgentFieldIssueReason =
  | 'empty'
  | 'bounds'
  | 'control_char'
  | 'unterminated_quote'
  | 'quoted_line_break'
  | 'shell_operator'
  | 'reserved_name'
  | 'prototype_key'
  | 'case_collision'
  | 'env_total_bounds'
  | 'duplicate_id'
  | 'identity_mismatch'

export type AgentFieldIssue = {
  field: 'identity' | 'baseAgent' | 'label' | 'commandOverride' | 'args' | 'env'
  reason: AgentFieldIssueReason
  envEntryIndex?: number
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// Unicode White_Space, which covers more than \s adds (e.g. U+0085, U+180E excluded
// by design — it lost White_Space in Unicode 6.3; \s in JS matches the current set).
const WHITE_SPACE_RUN_RE = /\s+/gu

/** Canonical label form: trimmed, NFKC-normalized, White_Space runs collapsed to
 *  one space. This is the persisted display text. */
export function normalizeAgentLabelText(label: string): string {
  return label.normalize('NFKC').replace(WHITE_SPACE_RUN_RE, ' ').trim()
}

/** Shared collision key for label uniqueness across built-in canonical English
 *  names, live custom labels, and referenced tombstone labels. */
export function normalizeAgentLabelKey(label: string): string {
  return normalizeAgentLabelText(label).toLocaleLowerCase('en-US')
}

const BUILT_IN_LABEL_KEYS: ReadonlySet<string> = new Set(
  Object.values(TUI_AGENT_DISPLAY_NAMES).map((name) => normalizeAgentLabelKey(name))
)

export function isBuiltInAgentLabelKey(labelKey: string): boolean {
  return BUILT_IN_LABEL_KEYS.has(labelKey)
}

export function validateAgentLabel(label: unknown): AgentFieldIssue | null {
  if (typeof label !== 'string') {
    return { field: 'label', reason: 'empty' }
  }
  const normalized = normalizeAgentLabelText(label)
  if (normalized.length === 0) {
    return { field: 'label', reason: 'empty' }
  }
  if (normalized.length > MAX_AGENT_LABEL_CODE_UNITS) {
    return { field: 'label', reason: 'bounds' }
  }
  return null
}

/** Surrogate-safe display truncation for locally rendering an invalid persisted
 *  label; never written back to the store. */
export function truncateAgentLabelForDisplay(label: string, maxCodeUnits: number): string {
  if (label.length <= maxCodeUnits) {
    return label
  }
  let end = maxCodeUnits
  const last = label.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1
  }
  return label.slice(0, end)
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// TextEncoder instead of Buffer so this module stays loadable in renderer/web
// bundles that have no Node globals.
const UTF8_ENCODER = new TextEncoder()

export function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length
}

// NUL, CR, and LF are rejected in env values; a code-unit scan avoids a
// control-character regex literal while covering the exact same set.
function hasEnvValueControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0 || code === 10 || code === 13) {
      return true
    }
  }
  return false
}

/** Serialized configured-env size: the larger of UTF-8 bytes and Windows UTF-16
 *  `key=value\0` code units including the final block terminator. */
export function measureCustomAgentEnvBytes(env: Readonly<Record<string, string>>): number {
  let utf8 = 0
  let utf16 = 0
  for (const [key, value] of Object.entries(env)) {
    const entry = `${key}=${value}`
    utf8 += utf8ByteLength(entry) + 1
    utf16 += entry.length + 1
  }
  // The Windows block carries one extra terminating NUL after the final entry.
  utf16 += 1
  return Math.max(utf8, utf16)
}

export function validateCustomAgentEnv(env: unknown): AgentFieldIssue[] {
  if (env === null || env === undefined) {
    return []
  }
  if (typeof env !== 'object' || Array.isArray(env)) {
    return [{ field: 'env', reason: 'bounds' }]
  }
  const issues: AgentFieldIssue[] = []
  const entries = Object.entries(env as Record<string, unknown>)
  if (entries.length > MAX_CUSTOM_AGENT_ENV_ENTRIES) {
    issues.push({ field: 'env', reason: 'bounds' })
  }
  const seenCaseInsensitive = new Map<string, number>()
  const validated: Record<string, string> = Object.create(null) as Record<string, string>
  entries.forEach(([key, value], index) => {
    if (PROTOTYPE_KEYS.has(key)) {
      issues.push({ field: 'env', reason: 'prototype_key', envEntryIndex: index })
      return
    }
    if (!ENV_KEY_RE.test(key) || key.length > MAX_CUSTOM_AGENT_ENV_KEY_CODE_UNITS) {
      issues.push({ field: 'env', reason: 'bounds', envEntryIndex: index })
      return
    }
    // Why: ORCA_* is the host attribution/control namespace; user values there
    // could impersonate pane identity or hook credentials (case-insensitive to
    // match Windows env semantics).
    if (key.toLowerCase().startsWith('orca_')) {
      issues.push({ field: 'env', reason: 'reserved_name', envEntryIndex: index })
      return
    }
    const lower = key.toLowerCase()
    if (seenCaseInsensitive.has(lower)) {
      issues.push({ field: 'env', reason: 'case_collision', envEntryIndex: index })
      return
    }
    seenCaseInsensitive.set(lower, index)
    if (typeof value !== 'string') {
      issues.push({ field: 'env', reason: 'bounds', envEntryIndex: index })
      return
    }
    if (value.length > MAX_CUSTOM_AGENT_ENV_VALUE_CODE_UNITS) {
      issues.push({ field: 'env', reason: 'bounds', envEntryIndex: index })
      return
    }
    if (hasEnvValueControlChar(value)) {
      issues.push({ field: 'env', reason: 'control_char', envEntryIndex: index })
      return
    }
    validated[key] = value
  })
  if (issues.length === 0 && measureCustomAgentEnvBytes(validated) > MAX_CUSTOM_AGENT_ENV_BYTES) {
    issues.push({ field: 'env', reason: 'env_total_bounds' })
  }
  return issues
}

// ---------------------------------------------------------------------------
// Command override
// ---------------------------------------------------------------------------

// Whitespace-delimited shell operator/pipeline syntax that is almost certainly an
// attempted command list rather than a filename character: ` && `, ` || `, ` | `,
// ` ; `, ` & ` plus trailing/leading equivalents. A metacharacter embedded in a
// path segment (no surrounding whitespace) stays data.
const COMMAND_OVERRIDE_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||[|;&]|[<>]{1,2})(?:\s|$)/

/** Decode at most one matched pair of outer quotes accepted by the editor and
 *  return the canonical raw value stored/persisted. */
export function canonicalizeCommandOverride(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1)
      // Only a fully matched single outer pair decodes; embedded quotes remain data.
      if (!inner.includes(first)) {
        return inner
      }
    }
  }
  return trimmed
}

export function validateCommandOverride(value: unknown): AgentFieldIssue | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return { field: 'commandOverride', reason: 'empty' }
  }
  const canonical = canonicalizeCommandOverride(value)
  if (canonical.length === 0) {
    return { field: 'commandOverride', reason: 'empty' }
  }
  if (canonical.length > MAX_COMMAND_PATH_LENGTH) {
    return { field: 'commandOverride', reason: 'bounds' }
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\0\r\n\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(canonical)) {
    return { field: 'commandOverride', reason: 'control_char' }
  }
  // Unbalanced legacy outer quoting: starts or ends with a quote that did not
  // decode as a matched pair above.
  const first = canonical[0]
  const last = canonical.at(-1)
  if (first === '"' || first === "'" || last === '"' || last === "'") {
    return { field: 'commandOverride', reason: 'unterminated_quote' }
  }
  if (COMMAND_OVERRIDE_OPERATOR_RE.test(canonical)) {
    // Rejected as likely accidental shell syntax for repairability, not because
    // the structured argv boundary could execute it.
    return { field: 'commandOverride', reason: 'shell_operator' }
  }
  return null
}

/** Built-in command overrides keep multi-token wrapper compatibility, so only
 *  hard bounds and control characters are save-rejected (operator tokens fail at
 *  launch, repairably) — never the one-executable quote/operator rules above. The
 *  raw value is preserved, not canonicalized to a single argv element. */
export function validateBuiltInCommandOverride(value: string | null): AgentFieldIssue | null {
  if (value === null) {
    return null
  }
  if (value.length > MAX_COMMAND_PATH_LENGTH) {
    return { field: 'commandOverride', reason: 'bounds' }
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\0\r\n\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return { field: 'commandOverride', reason: 'control_char' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Args template
// ---------------------------------------------------------------------------

export function validateAgentArgs(value: unknown): AgentFieldIssue | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return { field: 'args', reason: 'bounds' }
  }
  if (value.length > MAX_AGENT_ARGS_CODE_UNITS) {
    return { field: 'args', reason: 'bounds' }
  }
  const result = validateAgentArgsTemplate(value)
  if (!result.ok) {
    return { field: 'args', reason: result.reason }
  }
  return null
}

/** Built-in args are legacy shell text tokenized per target shell at launch, not
 *  the v1 custom grammar, so only the length bound is save-rejected here. */
export function validateBuiltInArgs(value: string): AgentFieldIssue | null {
  if (value.length > MAX_AGENT_ARGS_CODE_UNITS) {
    return { field: 'args', reason: 'bounds' }
  }
  return null
}
