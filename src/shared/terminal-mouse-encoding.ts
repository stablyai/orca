/** Mouse report encoding armed by DECSET 1006 (SGR) or 1016 (SGR pixels); independent of the tracking protocol. */
export type TerminalMouseEncoding = 'default' | 'sgr' | 'sgr-pixels'

/** Private xterm surface read below; optional because an xterm upgrade can move or drop it. */
type TerminalWithMouseStateCore = {
  // Why: required public members keep this from being a weak type, so xterm Terminals assign uncast.
  readonly cols: number
  readonly rows: number
  _core?: { mouseStateService?: { activeEncoding?: unknown } }
}

/**
 * Reads the encoding xterm itself parsed. Its public `modes` exposes the
 * tracking protocol but not the encoding, and SerializeAddon omits it, so a
 * restored pane otherwise emits legacy `ESC [ M` reports that a ConPTY host
 * types into the app as text (#23818).
 */
export function readTerminalMouseEncoding(
  terminal: TerminalWithMouseStateCore
): TerminalMouseEncoding {
  const encoding = terminal._core?.mouseStateService?.activeEncoding
  if (encoding === 'SGR') {
    return 'sgr'
  }
  if (encoding === 'SGR_PIXELS') {
    return 'sgr-pixels'
  }
  return 'default'
}

export function buildMouseEncodingRestoreSequence(encoding: TerminalMouseEncoding): string {
  switch (encoding) {
    case 'sgr':
      return '\x1b[?1006h'
    case 'sgr-pixels':
      return '\x1b[?1016h'
    case 'default':
      return ''
  }
}
