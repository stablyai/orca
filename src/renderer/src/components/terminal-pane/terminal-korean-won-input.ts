export type TerminalKoreanWonInputEvent = {
  type: string
  key: string
  code?: string
  keyCode?: number
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type TerminalKoreanWonInputOptions = {
  enabled: boolean
  isMac: boolean
  /** Whether the active macOS input source is a Korean keyboard (see korean-input-source.ts). */
  isKoreanKeyboard: boolean
}

export type TerminalKoreanWonInputAction = { type: 'input'; data: string } | { type: 'suppress' }

function isPlainBackquoteKeystroke(event: TerminalKoreanWonInputEvent): boolean {
  // Why: the rewrite keys on the keystroke position (the English QWERTY
  // backquote key, kVK_ANSI_Grave) alone — Korean layouts disagree about what
  // that key produces (두벌식/세벌식 390: ₩, 세벌식 최종: *, English state: `),
  // so no character check, no layout-variant knowledge. keyCode 229 means an
  // IME owns the press; translating it would race the IME's commit.
  return (
    event.keyCode !== 229 &&
    event.code === 'Backquote' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function resolveTerminalKoreanWonInput(
  event: TerminalKoreanWonInputEvent,
  options: TerminalKoreanWonInputOptions
): TerminalKoreanWonInputAction | null {
  if (
    !options.enabled ||
    !options.isMac ||
    !options.isKoreanKeyboard ||
    !isPlainBackquoteKeystroke(event)
  ) {
    return null
  }

  if (event.type === 'keydown') {
    return { type: 'input', data: '`' }
  }

  if (event.type === 'keypress' || event.type === 'keyup') {
    // Why: suppress companion events so the translated keydown cannot be
    // followed by a browser text event or xterm key-release sequence for the
    // layout's own character.
    return { type: 'suppress' }
  }

  return null
}
