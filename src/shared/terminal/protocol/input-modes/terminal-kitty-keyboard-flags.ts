export const KITTY_DISAMBIGUATE_ESCAPE_CODES = 0b00001
export const KITTY_REPORT_EVENT_TYPES = 0b00010
export const KITTY_REPORT_ALTERNATE_KEYS = 0b00100
export const KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES = 0b01000
export const KITTY_REPORT_ASSOCIATED_TEXT = 0b10000

export function kittyReportsAllKeysAsEscapeCodes(flags: number): boolean {
  return (flags & KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES) !== 0
}

/** Validate snapshot flags across IPC, remote decoding and restore. Absent/invalid means unproven, never known zero;
 * coercing to 0 could make Preview send legacy text to a bit-3 TUI. */
export function parseTerminalKittyKeyboardFlags(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
