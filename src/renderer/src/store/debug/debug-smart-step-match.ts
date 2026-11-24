import type { DebugInlineStepRange, DebugStepInTarget } from './debug-session-types'

const IDENT_CHAR = /[\p{L}\p{N}_$]/u

/** Extract the callee identifier from labels like `a.b.parse(str(i))` -> `parse`. */
export function calleeName(label: string): string | null {
  const head = label.split('(')[0]?.trim() ?? ''
  const name = head.split(/[.:#\s]+/).pop() ?? ''
  return name && [...name].every((ch) => IDENT_CHAR.test(ch)) ? name : null
}

function callPattern(name: string): RegExp {
  return new RegExp(`${name.replace(/\$/g, '\\$')}\\s*\\(`, 'gu')
}

function isCallBoundary(text: string, from: number): boolean {
  return !/(?:\p{L}|\p{N}|[_$])$/u.test(text.slice(Math.max(0, from - 2), from))
}

function identifierEnd(text: string, from: number): number {
  let i = from
  while (i < text.length && IDENT_CHAR.test(text[i] ?? '')) {
    i += 1
  }
  return i
}

/**
 * Filter DAP step-in targets to calls present on `line1Based`.
 * Some adapters (e.g. debugpy) omit line/column info; keep those whose callee name appears on the line.
 */
export function targetsOnLine(
  lineText: string,
  line1Based: number,
  targets: readonly DebugStepInTarget[]
): DebugStepInTarget[] {
  const kept = targets.filter((t) => {
    if (t.line != null) {
      return t.line === line1Based
    }
    if (t.column != null) {
      return true
    }
    const name = calleeName(t.label)
    return (
      !name ||
      [...lineText.matchAll(callPattern(name))].some(
        (m) => m.index !== undefined && isCallBoundary(lineText, m.index)
      )
    )
  })
  return kept.length > 0 ? kept : [...targets]
}

/**
 * Map DAP step-in targets (1-based line/column/endColumn) to 0-based UTF-16 ranges inside `lineText`.
 * Returns `null` when any target cannot be uniquely placed, signaling fallback to a list chooser.
 */
export function locateStepTargets(
  lineText: string,
  line1Based: number,
  targets: readonly DebugStepInTarget[]
): DebugInlineStepRange[] | null {
  const used = new Set<number>()
  const out: DebugInlineStepRange[] = []
  for (const target of targets) {
    let from = -1
    let to = -1
    const col0 = target.column != null ? target.column - 1 : -1
    if (
      target.column != null &&
      (target.line == null || target.line === line1Based) &&
      col0 >= 0 &&
      col0 < lineText.length
    ) {
      from = col0
      to =
        target.endColumn != null && target.endColumn > target.column
          ? Math.min(target.endColumn - 1, lineText.length)
          : identifierEnd(lineText, from)
    } else {
      const name = calleeName(target.label)
      if (!name) {
        return null
      }
      for (const m of lineText.matchAll(callPattern(name))) {
        if (m.index === undefined || used.has(m.index) || !isCallBoundary(lineText, m.index)) {
          continue
        }
        from = m.index
        to = from + name.length
        break
      }
    }
    if (from < 0 || to <= from || used.has(from)) {
      return null
    }
    used.add(from)
    out.push({ id: target.id, from, to })
  }
  return out.sort((a, b) => a.from - b.from)
}
