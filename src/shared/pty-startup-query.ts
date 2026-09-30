import { parseTerminalOscColorQuery } from './terminal-osc-color-reply'

const KITTY_QUERY = '\x1b[?u'

/** Startup owns only the exact Kitty capability query, never mode changes or keystrokes. */
export function parsePtyStartupQuery(data: string, offset: number, kitty: boolean) {
  if (kitty) {
    if (data.startsWith(KITTY_QUERY, offset)) {
      return { kind: 'kitty' as const, endIndex: offset + KITTY_QUERY.length }
    }
    if (KITTY_QUERY.startsWith(data.slice(offset))) {
      return { kind: 'partial' as const }
    }
  }
  return parseTerminalOscColorQuery(data, offset)
}
