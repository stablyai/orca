/** Bare ETX. Shells and TUIs that are not in the kitty keyboard protocol treat this as Ctrl+C. */
export const TERMINAL_INTERRUPT_ETX = '\x03'

/**
 * Kitty keyboard protocol encoding of Ctrl+C (`CSI 99 ; 5 u`).
 * A TUI that enabled the protocol does not treat a bare ETX as Ctrl+C (#17665).
 */
export const TERMINAL_INTERRUPT_KITTY_CTRL_C = '\x1b[99;5u'

/**
 * Interrupt bytes for one PTY write.
 * `kittyKeyboardFlags === 0` keeps ETX so a plain shell is unchanged.
 */
export function terminalInterruptBytes(kittyKeyboardFlags: number): string {
  return kittyKeyboardFlags > 0 ? TERMINAL_INTERRUPT_KITTY_CTRL_C : TERMINAL_INTERRUPT_ETX
}
