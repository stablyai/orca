// Why this module exists: xterm's public onData stream mixes real keystrokes
// with the parser's synthetic replies to terminal queries a program embedded in
// its output (CPR/DSR cursor + device-status reports, DA device attributes,
// DECRPM mode reports, window/cell pixel-size reports, OSC 10/11 color reports,
// kitty keyboard flag reports, DCS-framed DECRQSS/XTVERSION reports).
// A querying program (e.g. starship/orb) reads these replies synchronously in
// raw mode with a short timeout, so on the remote path they must NOT sit behind
// the input debounce — a late reply lands on the shell prompt in cooked mode,
// which echoes it literally and splices it into the next typed line (#7329).
// This classifier lets the transport send replies immediately while keeping
// ordinary typed input (including bursty arrow-key auto-repeat) coalesced.

const ESC = String.fromCharCode(0x1b)

// Built via new RegExp from \u-escaped strings so no literal control
// characters appear in the source. // Final bytes of xterm's own query-reply grammars:
//   R  — CPR / DECXCPR cursor position report (answer to CSI 6n / CSI ? 6n)
//   n  — DSR device status report (answer to CSI 5n → CSI 0n)
//   c  — DA1/DA2/DA3 device attributes (answer to CSI c / CSI > c / CSI = c)
//   t  — window/cell pixel-size + text-area-size reports (CSI 14t/16t/18t)
//   y  — DECRPM mode report (answer to CSI ? Ps $ p), body ends "$y"
//   u  — kitty keyboard flags report (answer to CSI ? u), carries "?"
/* oxlint-disable no-control-regex -- grammars match terminal ESC/BEL sequences by definition */
// Known accepted collision: xterm.js encodes MODIFIED F3 (Shift/Ctrl/Alt+F3) as
// `CSI 1 ; <mod> R`, which is indistinguishable from a CPR report (a classic
// VT ambiguity). Such a keystroke is sent immediately instead of debounced —
// byte order is still preserved (the immediate path flushes pending input
// first), it just skips input-intent/activity bookkeeping. Harmless, so we
// keep the reply grammar complete rather than special-casing it.
const CPR_OR_DSR_RE = new RegExp('^\\u001b\\[\\??[0-9;]*[Rn]$')
const DEVICE_ATTRIBUTES_RE = new RegExp('^\\u001b\\[[?>=]?[0-9;]*c$')
// 4/6 = pixel-size reports, 8 = text-area size in characters (answer to CSI 18t).
const WINDOW_SIZE_REPORT_RE = new RegExp('^\\u001b\\[[468];[0-9]+;[0-9]+t$')
// `?` optional: private-mode reports carry it (DECRPM), ANSI-mode reports don't.
const DECRPM_RE = new RegExp('^\\u001b\\[\\??[0-9;]*\\$y$')
// Kitty keyboard protocol flags report: CSI ? flags u. The `?` distinguishes it
// from kitty-protocol *keystrokes* (CSI code;mods u), which must stay batched.
const KITTY_FLAGS_RE = new RegExp('^\\u001b\\[\\?[0-9]+u$')
// OSC color/title responses: ESC ] Ps ; body ST (ST = BEL or ESC backslash).
const OSC_RESPONSE_RE = new RegExp('^\\u001b\\][0-9]+;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)$')
// DCS-framed reports xterm emits: DECRQSS "ESC P 1 $ r Pt ST" / "ESC P 0 $ r ST"
// (vim queries cursor style this way) and XTVERSION "ESC P > | text ST".
const DCS_RESPONSE_RE = new RegExp('^\\u001bP(?:[01]\\$r[^\\u001b]*|>\\|[^\\u001b]*)\\u001b\\\\$')
// Private-mode DSR (CSI ? … n) — e.g. color-scheme `?997;1n` — often lands cooked.
// Prefix form peels consecutive replies out of one coalesced payload.
const COOKED_ECHO_RISK_PRIVATE_DSR_PREFIX_RE = new RegExp('^\\u001b\\[\\?[0-9;]*n')
const COOKED_ECHO_RISK_OSC_PREFIX_RE = new RegExp(
  '^\\u001b\\][0-9]+;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)'
)
/* oxlint-enable no-control-regex */

/**
 * True when `data` (from xterm.onData) is a synthetic reply the emulator
 * generated in response to a query — not something the user typed. These are
 * latency-critical and must bypass input coalescing on the remote transport.
 *
 * Conservative by design: matches only complete, well-formed reply grammars so
 * ordinary keystrokes and navigation sequences (arrows CSI A/B/C/D, Home/End,
 * function keys ending in ~, kitty CSI-u keystrokes) are never misclassified
 * as replies — with the single documented modified-F3/CPR collision above.
 */
export function isTerminalQueryReply(data: string): boolean {
  if (data.length < 3 || data[0] !== ESC) {
    return false
  }
  return (
    CPR_OR_DSR_RE.test(data) ||
    DEVICE_ATTRIBUTES_RE.test(data) ||
    WINDOW_SIZE_REPORT_RE.test(data) ||
    DECRPM_RE.test(data) ||
    KITTY_FLAGS_RE.test(data) ||
    OSC_RESPONSE_RE.test(data) ||
    DCS_RESPONSE_RE.test(data)
  )
}

/** End index (exclusive) of one cooked-echo-risk reply at `start`, else -1. */
function cookedEchoSafeReplyEnd(data: string, start: number): number {
  if (start >= data.length || data[start] !== ESC) {
    return -1
  }
  const slice = data.slice(start)
  const dsr = COOKED_ECHO_RISK_PRIVATE_DSR_PREFIX_RE.exec(slice)
  if (dsr?.[0]) {
    return start + dsr[0].length
  }
  const osc = COOKED_ECHO_RISK_OSC_PREFIX_RE.exec(slice)
  if (osc?.[0]) {
    return start + osc[0].length
  }
  return -1
}

/**
 * If `data` is entirely one or more consecutive cooked-echo-risk replies, return each
 * reply. Repeats still arrive coalesced from a rapid theme flip or an older client that
 * answers 2031 subscribes (this host stopped — #9993), so peel them individually.
 * Mixed payloads (reply + keystroke) return null so hosts fall through to raw write.
 */
export function extractOnlyCookedEchoSafeQueryReplies(data: string): string[] | null {
  if (data.length < 4 || data[0] !== ESC) {
    return null
  }
  const replies: string[] = []
  let offset = 0
  while (offset < data.length) {
    const end = cookedEchoSafeReplyEnd(data, offset)
    if (end === -1) {
      return null
    }
    replies.push(data.slice(offset, end))
    offset = end
  }
  return replies.length > 0 ? replies : null
}

/**
 * Query replies that must use the ECHO-safe write path on POSIX PTYs so cooked
 * prompts do not paint reply bytes (e.g. `997;1n` on `npx` confirm, #13137).
 * Latency-critical CPR/DSR without `?` stay on the immediate write path.
 *
 * Whole-string only: a single complete reply. For repeated / write-queue
 * coalesced payloads use {@link extractOnlyCookedEchoSafeQueryReplies}.
 */
export function needsCookedEchoSafeQueryReply(data: string): boolean {
  const replies = extractOnlyCookedEchoSafeQueryReplies(data)
  return replies !== null && replies.length === 1
}

/** True if at least one extracted cooked-echo-risk reply is accepted by `answer`. */
export function answerEachCookedEchoSafeQueryReply(
  data: string,
  answer: (reply: string) => boolean
): boolean {
  const replies = extractOnlyCookedEchoSafeQueryReplies(data)
  if (!replies) {
    return false
  }
  let accepted = false
  for (const part of replies) {
    if (answer(part)) {
      accepted = true
    }
  }
  return accepted
}
