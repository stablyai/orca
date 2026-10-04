/** Bare ETX. Shells and TUIs that are not in the kitty keyboard protocol treat this as Ctrl+C. */
export const TERMINAL_INTERRUPT_ETX = '\x03'

/**
 * Kitty keyboard protocol encoding of Ctrl+C (`CSI 99 ; 5 u`).
 * A TUI that enabled the protocol does not treat a bare ETX as Ctrl+C (#17665).
 */
export const TERMINAL_INTERRUPT_KITTY_CTRL_C = '\x1b[99;5u'

/** Both wire encodings carry the same Ctrl+C intent back through the renderer input path. */
export function isTerminalInterruptInput(data: string): boolean {
  return data === TERMINAL_INTERRUPT_ETX || data === TERMINAL_INTERRUPT_KITTY_CTRL_C
}

/** True when an accepted input chunk contains either Ctrl+C wire encoding. */
export function containsTerminalInterruptInput(data: string): boolean {
  return data.includes(TERMINAL_INTERRUPT_ETX) || data.includes(TERMINAL_INTERRUPT_KITTY_CTRL_C)
}

/**
 * Progressive-enhancement bits that change Ctrl+C from a legacy ETX into CSI u.
 * Alternate-key reporting (4) only annotates sequences that are already encoded,
 * so `CSI >4u` must still interrupt with ETX.
 */
const KITTY_CTRL_C_ESCAPE_FLAGS = 1 | 8

/**
 * Interrupt bytes for one PTY write.
 * A plain shell, and a TUI that only asked for alternate keys, still get ETX.
 */
export function terminalInterruptBytes(kittyKeyboardFlags: number): string {
  return (kittyKeyboardFlags & KITTY_CTRL_C_ESCAPE_FLAGS) !== 0
    ? TERMINAL_INTERRUPT_KITTY_CTRL_C
    : TERMINAL_INTERRUPT_ETX
}
