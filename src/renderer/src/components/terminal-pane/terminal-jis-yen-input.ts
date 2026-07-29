export type TerminalJisYenInputEvent = {
  type: string
  key: string
  code?: string
  keyCode?: number
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type TerminalJisYenInputOptions = {
  enabled: boolean
  isMac: boolean
}

export type TerminalJisYenInputAction = { type: 'input'; data: string } | { type: 'suppress' }

function isPlainPhysicalJisYenKey(event: TerminalJisYenInputEvent): boolean {
  // Why: event.key='¥' can come from input methods or other layouts; IntlYen
  // scopes the rewrite to the physical JIS key the setting names. keyCode 229
  // means an IME owns the press — translating it would race the IME's commit.
  return (
    event.keyCode !== 229 &&
    event.code === 'IntlYen' &&
    event.key === '¥' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function resolveTerminalJisYenInput(
  event: TerminalJisYenInputEvent,
  options: TerminalJisYenInputOptions
): TerminalJisYenInputAction | null {
  if (!options.enabled || !options.isMac || !isPlainPhysicalJisYenKey(event)) {
    return null
  }

  if (event.type === 'keydown') {
    return { type: 'input', data: '\\' }
  }

  if (event.type === 'keypress' || event.type === 'keyup') {
    // Why: suppress companion events so the translated keydown cannot be
    // followed by a browser text event or xterm key-release sequence for ¥.
    return { type: 'suppress' }
  }

  return null
}
