import { stripUnsafeDisplayCharacters } from '../../../shared/display-text-safety'
import { clampUtf8TextPrefix } from '../../../shared/utf8-byte-limits'

const WINDOW_TITLE_VARIABLES = ['appName', 'repo', 'worktree', 'branch', 'issueKey', 'tab'] as const
const VARIABLE_PATTERN = new RegExp(`\\$\\{(${WINDOW_TITLE_VARIABLES.join('|')})\\}`)
const SEPARATOR_TOKEN = '${separator}'
const MAX_VALUE_BYTES = 120

export const DEFAULT_WINDOW_TITLE_TEMPLATE =
  '${appName}${separator}${repo} / ${worktree} [${issueKey}]'

/** Text survives only between filled values (the piece next to the later one), so no dangling " / " or "[]". */
function renderSegment(segment: string, values: Map<string, string>): string {
  const parts = segment.split(VARIABLE_PATTERN)
  const filled = parts.map((part, i) => i % 2 === 1 && values.has(part))
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        return values.get(part) ?? ''
      }
      if (parts.length === 1) {
        return part
      }
      if (i === parts.length - 1) {
        return filled[i - 1] ? part : ''
      }
      return filled[i + 1] && (i === 0 || filled.slice(0, i).some(Boolean)) ? part : ''
    })
    .join('')
    .trim()
}

/** Fills `${name}` variables with sanitized, capped values and joins `${separator}` segments that rendered text. */
export function renderWindowTitle(
  template: string,
  values: Partial<Record<(typeof WINDOW_TITLE_VARIABLES)[number], string | null>>
): string {
  const filled = new Map<string, string>()
  for (const [name, value] of Object.entries(values)) {
    // Terminal titles are program-controlled: drop bidi/control characters and cap runaway lengths.
    const safe = stripUnsafeDisplayCharacters(value ?? '').trim()
    const clamped = clampUtf8TextPrefix(safe, MAX_VALUE_BYTES)
    if (safe) {
      filled.set(name, clamped === safe ? safe : `${clamped.trimEnd()}…`)
    }
  }
  return template
    .split(SEPARATOR_TOKEN)
    .map((segment) => renderSegment(segment, filled))
    .filter(Boolean)
    .join(' — ')
}
