// Why this module exists: xterm's public onData stream mixes real keystrokes
// with the parser's synthetic replies to terminal queries a program embedded in
// its output (CPR/DSR cursor + device-status reports, DA device attributes,
// DECRPM mode reports, window/cell pixel-size reports, OSC 10/11 color reports).
// A querying program (e.g. starship/orb) reads these replies synchronously in
// raw mode with a short timeout, so on the remote path they must NOT sit behind
// the input debounce — a late reply lands on the shell prompt in cooked mode,
// which echoes it literally and splices it into the next typed line (#7329).
// This classifier lets the transport send replies immediately while keeping
// ordinary typed input (including bursty arrow-key auto-repeat) coalesced.

const ESC = String.fromCharCode(0x1b)

// Built via new RegExp from \u-escaped strings so no literal control
// characters appear in the source. // Final bytes of xterm's own query-reply grammars:
//   R  — CPR cursor position report (answer to CSI 6n)
//   n  — DSR device status report (answer to CSI 5n → CSI 0n)
//   c  — DA1/DA2/DA3 device attributes (answer to CSI c / CSI > c / CSI = c)
//   t  — window/cell pixel-size report (answer to CSI 14t / CSI 16t)
//   y  — DECRPM mode report (answer to CSI ? Ps $ p), body ends "$y"
/* oxlint-disable no-control-regex -- grammars match terminal ESC/BEL sequences by definition */
const CPR_OR_DSR_RE = new RegExp('^\\u001b\\[[0-9;]*[Rn]$')
const DEVICE_ATTRIBUTES_RE = new RegExp('^\\u001b\\[[?>=]?[0-9;]*c$')
const PIXEL_SIZE_RE = new RegExp('^\\u001b\\[[46];[0-9]+;[0-9]+t$')
const DECRPM_RE = new RegExp('^\\u001b\\[\\?[0-9;]*\\$y$')
// OSC color/title responses: ESC ] Ps ; body ST (ST = BEL or ESC backslash).
const OSC_RESPONSE_RE = new RegExp('^\\u001b\\][0-9]+;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)$')
/* oxlint-enable no-control-regex */

/**
 * True when `data` (from xterm.onData) is a synthetic reply the emulator
 * generated in response to a query — not something the user typed. These are
 * latency-critical and must bypass input coalescing on the remote transport.
 *
 * Conservative by design: matches only complete, well-formed reply grammars so
 * ordinary keystrokes and navigation sequences (arrows CSI A/B/C/D, Home/End,
 * function keys ending in ~) are never misclassified as replies.
 */
export function isTerminalQueryReply(data: string): boolean {
  if (data.length < 3 || data[0] !== ESC) {
    return false
  }
  return (
    CPR_OR_DSR_RE.test(data) ||
    DEVICE_ATTRIBUTES_RE.test(data) ||
    PIXEL_SIZE_RE.test(data) ||
    DECRPM_RE.test(data) ||
    OSC_RESPONSE_RE.test(data)
  )
}
