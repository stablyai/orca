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
