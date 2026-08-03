import { detachString, EMPTY_DETACHED_STRING, type DetachedString } from './detached-string'
import type { GlobalSettings } from './types'

export type TerminalColorSchemeMode = 'dark' | 'light'

const MODE_2031_SCAN_TAIL_LIMIT = 128

// Contour/Kitty "color-scheme update" protocol (DEC mode 2031 + CSI 997):
// terminals push `CSI ?997;1n` for dark and `CSI ?997;2n` for light to
// subscribed TUIs.
export function mode2031SequenceFor(mode: TerminalColorSchemeMode): string {
  return mode === 'dark' ? '\x1b[?997;1n' : '\x1b[?997;2n'
}

export function resolveTerminalColorSchemeMode(
  settings: Pick<GlobalSettings, 'theme'> | null | undefined,
  systemPrefersDark: boolean
): TerminalColorSchemeMode {
  const theme = settings?.theme ?? 'system'
  return theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : theme
}

export type Mode2031ScanResult = {
  subscribe: boolean
  unsubscribe: boolean
  finalState: 'subscribed' | 'unsubscribed' | null
  tail: DetachedString
  /**
   * The retained tail is a private-mode sequence still capable of resolving to
   * 2031 once the next chunk arrives — so `finalState` is provisional, not final.
   */
  tailMayResolveToMode2031: boolean
}

export type Mode2031ReplyScanState = {
  tail: DetachedString
  pendingSubscribe: boolean
}

export type Mode2031ReplyDecision = 'subscribed' | 'unsubscribed' | null

export type Mode2031ReplyScanResult = {
  decision: Mode2031ReplyDecision
  state: Mode2031ReplyScanState
}

export const INITIAL_MODE_2031_REPLY_SCAN_STATE: Mode2031ReplyScanState = {
  tail: EMPTY_DETACHED_STRING,
  pendingSubscribe: false
}

const NO_MODE_2031_REPLY_DECISION: Mode2031ReplyScanResult = {
  decision: null,
  state: INITIAL_MODE_2031_REPLY_SCAN_STATE
}

const NO_MODE_2031_SEQUENCE: Mode2031ScanResult = {
  subscribe: false,
  unsubscribe: false,
  finalState: null,
  tail: EMPTY_DETACHED_STRING,
  tailMayResolveToMode2031: false
}

export function scanMode2031Sequences(previousTail: string, data: string): Mode2031ScanResult {
  if (!previousTail && !data.includes('\x1b') && !data.includes('\x9b')) {
    return NO_MODE_2031_SEQUENCE
  }
  const input = `${previousTail}${data}`
  const tail = extractPrivateModeScanTail(input)
  const result: Mode2031ScanResult = {
    subscribe: false,
    unsubscribe: false,
    finalState: null,
    tail,
    tailMayResolveToMode2031: tailCouldStillBeMode2031(tail)
  }
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
  const privateModeRe = /\x1b\[\?([0-9;]+)([hl])|\x9b\?([0-9;]+)([hl])/g
  let match: RegExpExecArray | null
  while ((match = privateModeRe.exec(input)) !== null) {
    const params = match[1] ?? match[3]
    if (!hasMode2031(params)) {
      continue
    }
    if ((match[2] ?? match[4]) === 'h') {
      result.subscribe = true
      result.finalState = 'subscribed'
    } else {
      result.unsubscribe = true
      result.finalState = 'unsubscribed'
    }
  }
  return result
}

export function scanMode2031ReplyDecision(
  previous: Mode2031ReplyScanState,
  data: string
): Mode2031ReplyScanResult {
  if (
    !previous.pendingSubscribe &&
    !previous.tail &&
    !data.includes('\x1b') &&
    !data.includes('\x9b')
  ) {
    return NO_MODE_2031_REPLY_DECISION
  }
  const scan = scanMode2031Sequences(previous.tail, data)
  let decision = scan.finalState
  let pendingSubscribe = previous.pendingSubscribe

  if (scan.finalState === 'unsubscribed') {
    pendingSubscribe = false
  } else if (scan.finalState === 'subscribed' || pendingSubscribe) {
    if (scan.tailMayResolveToMode2031) {
      decision = null
      pendingSubscribe = true
    } else {
      decision = 'subscribed'
      pendingSubscribe = false
    }
  }

  return {
    decision,
    state: { tail: scan.tail, pendingSubscribe }
  }
}

function hasMode2031(params: string): boolean {
  return params.split(';').some((param) => Number(param) === 2031)
}

// Persisted per-pane tails must not retain their source PTY chunks.
function extractPrivateModeScanTail(input: string): DetachedString {
  const start = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'))
  if (start === -1) {
    return EMPTY_DETACHED_STRING
  }
  const tail = input.slice(start)
  if (tail.length > MODE_2031_SCAN_TAIL_LIMIT) {
    return EMPTY_DETACHED_STRING
  }
  if (tail === '\x1b' || tail === '\x1b[' || tail === '\x9b') {
    return detachString(tail)
  }
  if (tail.startsWith('\x1b[?')) {
    return isIncompletePrivateModeParams(tail.slice(3)) ? detachString(tail) : EMPTY_DETACHED_STRING
  }
  if (tail.startsWith('\x9b?')) {
    return isIncompletePrivateModeParams(tail.slice(2)) ? detachString(tail) : EMPTY_DETACHED_STRING
  }
  return EMPTY_DETACHED_STRING
}

function isIncompletePrivateModeParams(params: string): boolean {
  return /^[0-9;]*$/.test(params)
}

/**
 * Whether a retained (incomplete) private-mode tail could still turn out to be a
 * 2031 toggle. Lets the caller hold a provisional decision for one chunk instead
 * of answering a subscribe that the very next bytes withdraw (#9993).
 */
function tailCouldStillBeMode2031(tail: string): boolean {
  // Any retained private-mode prefix can still append `;2031` before its final byte.
  return tail.length > 0
}
