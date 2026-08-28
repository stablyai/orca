export const KITTY_DISAMBIGUATE_ESCAPE_CODES = 0b00001
export const KITTY_REPORT_EVENT_TYPES = 0b00010
export const KITTY_REPORT_ALTERNATE_KEYS = 0b00100
export const KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES = 0b01000
export const KITTY_REPORT_ASSOCIATED_TEXT = 0b10000

export function kittyReportsAllKeysAsEscapeCodes(flags: number): boolean {
  return (flags & KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES) !== 0
}

/**
 * Boundary validation for the optional `kittyKeyboardFlags` snapshot field
 * shared by Electron IPC, remote JSON decoding, and tracker restore.
 *
 * Absent means the snapshot owner could not PROVE the state — an old remote
 * host, an unsequenced renderer serializer, or a source with no mode metadata.
 * That is not the same fact as a proven inactive protocol, so an unparseable
 * value returns `undefined` rather than clamping or coercing to `0`; laundering
 * it into known zero would make Preview commit raw text against a bit-3 TUI.
 */
export function parseTerminalKittyKeyboardFlags(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
