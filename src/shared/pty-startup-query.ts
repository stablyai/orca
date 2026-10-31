import {
  parseTerminalOscColorQuery,
  type TerminalOscColorQueryParseResult
} from './terminal-osc-color-reply'
import {
  parseTerminalOscAppearanceQuery,
  type TerminalOscAppearanceQueryParseResult
} from './terminal-osc-appearance-query'

const KITTY_QUERY = '\x1b[?u'
export const COLOR_SCHEME_QUERY = '\x1b[?996n'
const OSC = '\x1b]'
const ESC = 0x1b
const OSC_INTRODUCER = 0x5d
const CSI_INTRODUCER = 0x5b
const PRIVATE_MARKER = 0x3f

/** Which non-colour queries the owner currently answers: Kitty during startup, the launcher's appearance for life. */
export type PtyStartupQueryScope = { kitty: boolean; appearance: boolean }

export type PtyStartupQuery =
  | { kind: 'kitty' | 'color-scheme'; endIndex: number }
  | TerminalOscColorQueryParseResult
  | TerminalOscAppearanceQueryParseResult

/** Startup owns only the exact Kitty capability query, never mode changes or keystrokes. */
export function parsePtyStartupQuery(
  data: string,
  offset: number,
  scope: PtyStartupQueryScope
): PtyStartupQuery {
  const csi =
    matchCsiQuery(data, offset, scope.kitty, 'kitty', KITTY_QUERY) ??
    matchCsiQuery(data, offset, scope.appearance, 'color-scheme', COLOR_SCHEME_QUERY)
  if (csi) {
    return csi
  }
  const color = parseTerminalOscColorQuery(data, offset)
  if (color.kind !== 'none' || !scope.appearance) {
    return color
  }
  return parseTerminalOscAppearanceQuery(data, offset)
}

function matchCsiQuery(
  data: string,
  offset: number,
  owned: boolean,
  kind: 'kitty' | 'color-scheme',
  query: string
): PtyStartupQuery | null {
  if (!owned) {
    return null
  }
  if (data.startsWith(query, offset)) {
    return { kind, endIndex: offset + query.length }
  }
  // Slice only a torn tail: it is shorter than the query.
  return data.length - offset < query.length && query.startsWith(data.slice(offset))
    ? { kind: 'partial' }
    : null
}

/** Next offset that can start a query. Owned CSI queries are all private (`ESC [ ?`), so SGR and other CSIs on the
 *  PTY hot path never reach the parser; a read can end right after the ESC or `ESC [` that opens a query. */
export function nextQueryCandidate(
  data: string,
  from: number,
  scope: PtyStartupQueryScope
): number {
  if (!scope.kitty && !scope.appearance) {
    const osc = data.indexOf(OSC, from)
    if (osc !== -1) {
      return osc
    }
    const last = data.length - 1
    return last >= from && data.charCodeAt(last) === ESC ? last : -1
  }
  for (
    let index = data.indexOf('\x1b', from);
    index !== -1;
    index = data.indexOf('\x1b', index + 1)
  ) {
    const next = data.charCodeAt(index + 1)
    if (
      index + 1 === data.length ||
      next === OSC_INTRODUCER ||
      (next === CSI_INTRODUCER &&
        (index + 2 === data.length || data.charCodeAt(index + 2) === PRIVATE_MARKER))
    ) {
      return index
    }
  }
  return -1
}
