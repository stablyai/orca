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
  tail: string
}

const NO_MODE_2031_SEQUENCE: Mode2031ScanResult = {
  subscribe: false,
  unsubscribe: false,
  tail: ''
}

export function scanMode2031Sequences(previousTail: string, data: string): Mode2031ScanResult {
  if (!previousTail && !data.includes('\x1b') && !data.includes('\x9b')) {
    return NO_MODE_2031_SEQUENCE
  }
  const input = `${previousTail}${data}`
  const result: Mode2031ScanResult = {
    subscribe: false,
    unsubscribe: false,
    tail: extractPrivateModeScanTail(input)
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
    } else {
      result.unsubscribe = true
    }
  }
  return result
}

function hasMode2031(params: string): boolean {
  return params.split(';').some((param) => Number(param) === 2031)
}

function extractPrivateModeScanTail(input: string): string {
  const start = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'))
  if (start === -1) {
    return ''
  }
  const tail = input.slice(start)
  if (tail.length > MODE_2031_SCAN_TAIL_LIMIT) {
    return ''
  }
  if (tail === '\x1b' || tail === '\x1b[' || tail === '\x9b') {
    return tail
  }
  if (tail.startsWith('\x1b[?')) {
    return isIncompletePrivateModeParams(tail.slice(3)) ? tail : ''
  }
  if (tail.startsWith('\x9b?')) {
    return isIncompletePrivateModeParams(tail.slice(2)) ? tail : ''
  }
  return ''
}

function isIncompletePrivateModeParams(params: string): boolean {
  return /^[0-9;]*$/.test(params)
}
