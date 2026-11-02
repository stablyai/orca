// xterm onData mixes keys and synthetic replies. Querying programs wait with short raw-mode timeouts; debounce can deliver replies to a cooked prompt and corrupt later input (#7329).
// Classify complete replies for immediate transport delivery while ordinary input stays coalesced.

const ESC = String.fromCharCode(0x1b)

// Build regexes from escaped strings to keep literal controls out of source.
/* oxlint-disable no-control-regex -- grammars match terminal ESC/BEL sequences by definition */
// Modified F3 is byte-identical to CPR. Accept immediate delivery/reply-budget shedding and echo-deferral reordering rather than omit a valid reply grammar.
const CPR_OR_DSR_PREFIX_RE = new RegExp('^\\u001b\\[\\??[0-9;]*[Rn]')
const DEVICE_ATTRIBUTES_PREFIX_RE = new RegExp('^\\u001b\\[[?>=]?[0-9;]*c')
// 4/6 = pixel-size reports, 8 = text-area size in characters (answer to CSI 18t).
const WINDOW_SIZE_REPORT_PREFIX_RE = new RegExp('^\\u001b\\[[468];[0-9]+;[0-9]+t')
// `?` optional: private-mode reports carry it (DECRPM), ANSI-mode reports don't.
const DECRPM_PREFIX_RE = new RegExp('^\\u001b\\[\\??[0-9;]*\\$y')
// The ? distinguishes Kitty flag replies from Kitty keystrokes, which must stay batched.
const KITTY_FLAGS_PREFIX_RE = new RegExp('^\\u001b\\[\\?[0-9]+u')
// Kitty graphics acknowledgements must bypass user-input activity and debounce.
const KITTY_GRAPHICS_PREFIX_RE = new RegExp(
  '^\\u001b_Gi=[0-9]+(?:,p=[0-9]+)?;(?:OK|E[A-Z]+:[^\\u0000-\\u001f]*)\\u001b\\\\'
)
// OSC color/title responses: ESC ] Ps ; body ST (ST = BEL or ESC backslash).
const OSC_RESPONSE_PREFIX_RE = new RegExp(
  '^\\u001b\\][0-9]+;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)'
)
// DCS-framed reports xterm emits: DECRQSS "ESC P 1 $ r Pt ST" / "ESC P 0 $ r ST"
// (vim queries cursor style this way) and XTVERSION "ESC P > | text ST".
const DCS_RESPONSE_PREFIX_RE = new RegExp(
  '^\\u001bP(?:[01]\\$r[^\\u001b]*|>\\|[^\\u001b]*)\\u001b\\\\'
)
// Private-mode DSR (CSI ? … n) — e.g. color-scheme `?997;1n` — often lands cooked.
// Prefix form peels consecutive replies out of one coalesced payload.
const COOKED_ECHO_RISK_PRIVATE_DSR_PREFIX_RE = new RegExp('^\\u001b\\[\\?[0-9;]*n')
const COOKED_ECHO_RISK_OSC_PREFIX_RE = new RegExp(
  '^\\u001b\\][0-9]+;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)'
)
// fish queries XTVERSION at startup; a gated reply would reach the launched agent instead (#16489).
const COOKED_ECHO_RISK_XTVERSION_PREFIX_RE = new RegExp('^\\u001bP>\\|[^\\u001b]*\\u001b\\\\')
const QUERY_REPLY_PREFIX_RES = [
  CPR_OR_DSR_PREFIX_RE,
  DEVICE_ATTRIBUTES_PREFIX_RE,
  WINDOW_SIZE_REPORT_PREFIX_RE,
  DECRPM_PREFIX_RE,
  KITTY_FLAGS_PREFIX_RE,
  KITTY_GRAPHICS_PREFIX_RE,
  OSC_RESPONSE_PREFIX_RE,
  DCS_RESPONSE_PREFIX_RE
] as const
/* oxlint-enable no-control-regex */

function terminalQueryReplyEnd(data: string, start: number): number {
  if (start >= data.length || data[start] !== ESC) {
    return -1
  }
  const slice = data.slice(start)
  for (const re of QUERY_REPLY_PREFIX_RES) {
    const match = re.exec(slice)
    if (match?.[0]) {
      return start + match[0].length
    }
  }
  return -1
}

/** Recognize one complete synthetic reply for immediate delivery; keep navigation/keystrokes batched except the documented modified-F3/CPR ambiguity. */
export function isTerminalQueryReply(data: string): boolean {
  return data.length >= 3 && terminalQueryReplyEnd(data, 0) === data.length
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
  const xtversion = COOKED_ECHO_RISK_XTVERSION_PREFIX_RE.exec(slice)
  if (xtversion?.[0]) {
    return start + xtversion[0].length
  }
  return -1
}

/** Split cooked-echo-risk-only payloads, including old-client 2031 answers and rapid theme flips; mixed key/reply payloads fall through to raw write. */
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

export function extractOnlyTerminalQueryReplies(data: string): string[] | null {
  if (data.length < 3 || data[0] !== ESC) {
    return null
  }
  const replies: string[] = []
  let offset = 0
  while (offset < data.length) {
    const end = terminalQueryReplyEnd(data, offset)
    if (end === -1) {
      return null
    }
    replies.push(data.slice(offset, end))
    offset = end
  }
  return replies.length > 0 ? replies : null
}

/** Single replies needing POSIX ECHO protection to avoid painting bytes on cooked prompts (#13137). CPR/public DSR stay immediate.
 * Use extractOnlyCookedEchoSafeQueryReplies for coalesced payloads. */
export function needsCookedEchoSafeQueryReply(data: string): boolean {
  const replies = extractOnlyCookedEchoSafeQueryReplies(data)
  return replies !== null && replies.length === 1
}
