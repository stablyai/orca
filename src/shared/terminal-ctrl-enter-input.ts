export const TERMINAL_ENTER_INPUT = '\r'
export const TERMINAL_CTRL_ENTER_CSI_U_INPUT = '\x1b[13;5u'

export function resolveTerminalCtrlEnterInput(
  kittyKeyboardFlags: number | null | undefined
): string {
  return (kittyKeyboardFlags ?? 0) > 0 ? TERMINAL_CTRL_ENTER_CSI_U_INPUT : TERMINAL_ENTER_INPUT
}
