/* eslint-disable no-control-regex -- These patterns intentionally match raw PTY control sequences. */

// ANSI/OSC strippers mirror the runtime normalizer, with URL-specific cursor
// move handling below to avoid fusing text that a real terminal would skip.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// Why: cursor moves in differential redraws can skip cells that are already on
// screen. Replacing them with a URL-invalid guard skips the damaged candidate.
const CURSOR_MOVE_PATTERN = /\x1b\[[0-?]*[ -/]*[CDGHf]/g
const CURSOR_MOVE_URL_GUARD = '['
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const SINGLE_ESC_PATTERN = /\x1b[@-_]/g
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g

export function stripTerminalControls(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(OSC_PATTERN, '')
    .replace(CURSOR_MOVE_PATTERN, CURSOR_MOVE_URL_GUARD)
    .replace(CSI_PATTERN, '')
    .replace(SINGLE_ESC_PATTERN, '')
    .replace(CONTROL_PATTERN, '')
}
