import type { ChangeDesc, Text } from '@codemirror/state'
import type { DebugBreakpoint, DebugScope, DebugVariable } from './debug-session-types'

/** Flatten multi-line debugger values onto a single display line. */
export function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ')
}

/** Single-line, length-limited representation for inline value hints and tooltips. */
export function inlineValue(value: string, max = 60): string {
  const flat = oneLine(value)
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Extract unique identifier tokens on a code line while ignoring string literals. */
export function identifiersIn(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ' ')
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = match[0]
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** Collect visible locals from expanded non-expensive scopes (or all scopes if none). */
export function collectFrameLocals(
  scopes: readonly DebugScope[],
  variablesByRef: Record<number, DebugVariable[]>
): Record<string, DebugVariable> {
  const locals: Record<string, DebugVariable> = {}
  const nonExpensive = scopes.filter((s) => !s.expensive)
  const ordered = nonExpensive.length > 0 ? nonExpensive : scopes
  for (const scope of ordered) {
    const vars = variablesByRef[scope.variablesReference]
    if (!vars) {
      continue
    }
    for (const variable of vars) {
      if (!Object.hasOwn(locals, variable.name)) {
        locals[variable.name] = variable
      }
    }
  }
  return locals
}

/** Map 1-based breakpoint line numbers through a CodeMirror document edit. */
export function mapBreakpointsThroughChanges(
  list: readonly DebugBreakpoint[],
  oldDoc: Text,
  changes: ChangeDesc,
  newDoc: Text
): DebugBreakpoint[] {
  if (changes.empty) {
    return [...list]
  }
  const out: DebugBreakpoint[] = []
  const seen = new Set<number>()
  const sorted = [...list].sort((a, b) => a.line - b.line)
  for (const bp of sorted) {
    if (bp.line < 1 || bp.line > oldDoc.lines) {
      if (!seen.has(bp.line)) {
        seen.add(bp.line)
        out.push(bp)
      }
      continue
    }
    const lineStart = oldDoc.line(bp.line).from
    // Assoc 1 so text inserted at column 0 pushes the breakpoint down with the line.
    const pos = changes.mapPos(lineStart, 1)
    const nextLine = newDoc.lineAt(Math.min(pos, newDoc.length)).number
    if (seen.has(nextLine)) {
      continue
    }
    seen.add(nextLine)
    out.push(nextLine === bp.line ? bp : { ...bp, line: nextLine })
  }
  return out
}

/** Return true when two breakpoint lists differ in count or line order. */
export function breakpointsLinesChanged(
  a: readonly DebugBreakpoint[],
  b: readonly DebugBreakpoint[]
): boolean {
  if (a.length !== b.length) {
    return true
  }
  return a.some((entry, idx) => entry.line !== b[idx]?.line)
}
