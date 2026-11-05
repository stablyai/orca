export const TERMINAL_KITTY_SHIFT_ENTER_INPUT = '\x1b[13;2u'

/** Ctrl+Backspace deletes the previous word, like readline's Ctrl+W. */
export const TERMINAL_CTRL_BACKSPACE_INPUT = '\x17'

/** ESC CR depends on Pi’s private Kitty-query result, which panes cannot observe. Armed modifyOtherKeys uses CSI 27;mod;13~ consistently in either state (STA-7701). */
export function encodeModifyOtherKeysEnter(
  modifyOtherKeys: number,
  modifier: 2 | 3
): string | null {
  return modifyOtherKeys > 0 ? `\x1b[27;${modifier};13~` : null
}

export function encodeTerminalShiftEnter({
  canSendCsiU,
  modifyOtherKeys
}: {
  canSendCsiU: boolean
  modifyOtherKeys: number
}): string {
  if (canSendCsiU) {
    return TERMINAL_KITTY_SHIFT_ENTER_INPUT
  }
  return encodeModifyOtherKeysEnter(modifyOtherKeys, 2) ?? '\x1b\r'
}
