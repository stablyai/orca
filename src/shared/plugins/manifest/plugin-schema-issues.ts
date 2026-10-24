import type { z } from 'zod'
import { isPluginJsonObject } from './plugin-json-object'

/** Enough to fix several mistakes per edit without flooding a one-line error surface. */
export const PLUGIN_SCHEMA_ISSUE_LIMIT = 8

/** `contributes.themes[0].path`; `(root)` for the document itself. */
export function formatPluginSchemaPath(path: readonly PropertyKey[]): string {
  let formatted = ''
  for (const segment of path) {
    formatted +=
      typeof segment === 'number' ? `[${segment}]` : `${formatted ? '.' : ''}${String(segment)}`
  }
  return formatted || '(root)'
}

function quoted(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ')
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`
}

function units(origin: string, count: number | bigint): string {
  if (origin === 'array' || origin === 'set') {
    return count === 1 ? '1 item' : `${count} items`
  }
  if (origin === 'string') {
    return count === 1 ? '1 character' : `${count} characters`
  }
  return String(count)
}

/** Unknown keys named per issue; a near-limit manifest must not produce a near-limit error. */
const UNKNOWN_KEY_LIMIT = 5
const LINE_MAX_LENGTH = 200

/** True when the issue's last path key is absent (or undefined) in the parsed input. */
function isMissing(input: unknown, path: readonly PropertyKey[]): boolean {
  let value: unknown = input
  for (const segment of path) {
    if (!isPluginJsonObject(value)) {
      return false
    }
    value = value[segment]
  }
  return path.length > 0 && value === undefined
}

function unknownKeys(keys: readonly string[]): string {
  const shown = quoted(keys.slice(0, UNKNOWN_KEY_LIMIT))
  const rest = keys.length - UNKNOWN_KEY_LIMIT
  return `unknown ${keys.length === 1 ? 'key' : 'keys'} ${shown}${rest > 0 ? ` and ${rest} more` : ''}`
}

// Why rewrite: zod's defaults read as parser internals and are locale-dependent; every message
// here is built from structured issue fields, and only messages our schemas set pass through.
function issueMessage(issue: z.core.$ZodIssue, input: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return isMissing(input, issue.path) ? 'is required' : `must be ${article(issue.expected)}`
    case 'unrecognized_keys':
      return unknownKeys(issue.keys)
    case 'invalid_value':
      return issue.values.length === 1
        ? `must be ${quoted(issue.values)}`
        : `must be one of ${quoted(issue.values)}`
    case 'too_big':
      return `must be at most ${units(issue.origin, issue.maximum)}`
    case 'too_small':
      return issue.origin === 'string' && issue.minimum === 1
        ? 'must not be empty'
        : `must be at least ${units(issue.origin, issue.minimum)}`
    case 'invalid_union':
      return 'options' in issue && Array.isArray(issue.options)
        ? `must be one of ${quoted(issue.options)}`
        : 'does not match any allowed shape'
    case 'invalid_format':
    case 'custom':
    case 'invalid_element':
    case 'invalid_key':
    case 'not_multiple_of':
      return issue.message
  }
}

function capped(line: string): string {
  return line.length > LINE_MAX_LENGTH ? `${line.slice(0, LINE_MAX_LENGTH - 1)}…` : line
}

/** Distinct `path: message` lines, at most `limit`, plus how many were left out. `input` is the
 *  parsed value, used to tell a missing field from a mistyped one. */
export function pluginSchemaIssueLines(
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
  limit = PLUGIN_SCHEMA_ISSUE_LIMIT
): string[] {
  const lines = [
    ...new Set(
      issues.map((issue) =>
        capped(`${formatPluginSchemaPath(issue.path)}: ${issueMessage(issue, input)}`)
      )
    )
  ]
  return lines.length > limit ? [...lines.slice(0, limit), `(${lines.length - limit} more)`] : lines
}

export function formatPluginSchemaIssues(
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
  limit = PLUGIN_SCHEMA_ISSUE_LIMIT
): string {
  return pluginSchemaIssueLines(issues, input, limit).join('; ')
}
