/* eslint-disable no-control-regex -- these patterns exist to match terminal control bytes. */

/** OSC title/progress frames, 7-bit (ESC ]) and 8-bit (U+009D) introducers. */
export const OSC_SEQUENCE_PATTERN = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g
/** DCS/APC/PM/SOS string sequences terminated by ST. */
export const STRING_SEQUENCE_PATTERN =
  /(?:\u001b[P_^X]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u001b\\|\u009c)/g
/** CSI sequences (colors, cursor moves, `\u001b[0K` erase-to-EOL). */
export const CSI_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
/** Remaining two/three-byte escape sequences (charset selection, RIS, ...). */
export const ESCAPE_SEQUENCE_PATTERN = /\u001b[ -/]*[0-~]/g
/** C0/C1 control bytes except tab, line feed and carriage return. */
export const TERMINAL_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * Remove ANSI escape sequences while preserving text, tabs and line breaks.
 * Ordering matters: OSC/string sequences must be consumed before the generic
 * escape pattern, which would otherwise eat only their introducer.
 */
export function stripAnsiEscapeSequences(value: string): string {
  return value
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(STRING_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
}
