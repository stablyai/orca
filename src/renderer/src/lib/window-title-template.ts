import { stripUnsafeDisplayCharacters } from '../../../shared/text/display-text-safety'
import { clampUtf8TextPrefix } from '../../../shared/text/utf8-byte-limits'

const WINDOW_TITLE_VARIABLES = ['appName', 'repo', 'worktree', 'branch', 'issueKey', 'tab'] as const
const KNOWN_VARIABLES = new Set<string>(WINDOW_TITLE_VARIABLES)
const PLACEHOLDER_PATTERN = /\$\{([^}]*)\}/
const LEADING_CLOSERS = /^[)\]}>]*/
const TRAILING_OPENERS = /[([{<]*$/
// Innermost [...] or (...) that holds a placeholder.
const BRACKET_GROUP_PATTERN =
  /\[([^[\]()]*\$\{[^}]*\}[^[\]()]*)\]|\(([^[\]()]*\$\{[^}]*\}[^[\]()]*)\)/g
const SEPARATOR_TOKEN = '${separator}'
const MAX_VALUE_BYTES = 120

export const DEFAULT_WINDOW_TITLE_TEMPLATE =
  '${appName}${separator}${repo} / ${worktree} [${issueKey}]'

/** Text survives only between filled values (the piece next to the later one), so no dangling " / " or "[]". */
function renderSegment(segment: string, values: Map<string, string>): string {
  // A bracket group renders as one value, kept whole when anything inside it is filled.
  const scope = new Map(values)
  let groups = 0
  let template = segment
  for (let previous = ''; previous !== template;) {
    previous = template
    template = template.replace(BRACKET_GROUP_PATTERN, (group, square, round) => {
      const name = `\0group${groups++}`
      const inner = renderSegment(square ?? round, scope)
      if (inner) {
        scope.set(name, `${group[0]}${inner}${group.at(-1)}`)
      }
      return `\${${name}}`
    })
  }
  const parts = template.split(PLACEHOLDER_PATTERN)
  // Unknown placeholders stay literal, so they count as filled text.
  const valueOf = (name: string) =>
    KNOWN_VARIABLES.has(name) || name.startsWith('\0') ? scope.get(name) : `\${${name}}`
  const filled = parts.map((part, i) => i % 2 === 1 && valueOf(part) !== undefined)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        return valueOf(part) ?? ''
      }
      if (parts.length === 1) {
        return part
      }
      if (i === parts.length - 1) {
        return filled[i - 1] ? part : ''
      }
      if (filled[i + 1] && (i === 0 || filled.slice(0, i).some(Boolean))) {
        return i > 0 && !filled[i - 1] ? part.replace(LEADING_CLOSERS, '') : part
      }
      // A closing bracket belongs to the filled value before it, an opening one to the value after it.
      const closer = filled[i - 1] ? (LEADING_CLOSERS.exec(part)?.[0] ?? '') : ''
      return closer + (filled[i + 1] ? (TRAILING_OPENERS.exec(part)?.[0] ?? '') : '')
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
    if (safe) {
      const fits = clampUtf8TextPrefix(safe, MAX_VALUE_BYTES) === safe
      // The ellipsis takes 3 UTF-8 bytes of the cap.
      filled.set(name, fits ? safe : `${clampUtf8TextPrefix(safe, MAX_VALUE_BYTES - 3).trimEnd()}…`)
    }
  }
  return template
    .split(SEPARATOR_TOKEN)
    .map((segment) => renderSegment(segment, filled))
    .filter(Boolean)
    .join(' — ')
}
