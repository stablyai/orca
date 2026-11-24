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
  // Scope ¥ rewrite to physical IntlYen; other layouts may emit ¥, and keyCode 229 means the IME owns the commit.
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
    // Suppress companion events so the rewritten keydown cannot also emit ¥ text or release bytes.
    return { type: 'suppress' }
  }

  return null
}
