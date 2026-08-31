const KITTY_KEYBOARD_STATUS_QUERY = '\x1b[?u'

export type TerminalKittyKeyboardQuery =
  | { kind: 'none' }
  | { kind: 'partial' }
  | { kind: 'complete'; endIndex: number }

export function parseTerminalKittyKeyboardQuery(
  input: string,
  startIndex: number
): TerminalKittyKeyboardQuery {
  const candidate = input.slice(startIndex)
  if (candidate.startsWith(KITTY_KEYBOARD_STATUS_QUERY)) {
    return { kind: 'complete', endIndex: startIndex + KITTY_KEYBOARD_STATUS_QUERY.length }
  }
  return KITTY_KEYBOARD_STATUS_QUERY.startsWith(candidate) ? { kind: 'partial' } : { kind: 'none' }
}

export const terminalKittyKeyboardStatusReply = '\x1b[?0u'
