/**
 * Keydown rewriting for the terminal "Korean Won (₩) to Backquote (`)" setting.
 *
 * While a Korean input source is active on macOS, the physical backquote key
 * (code 'Backquote' — the English QWERTY backquote position) produces a
 * character Korean layouts disagree about (₩ under 두벌식/세벌식 390, * under
 * 세벌식 최종, ` in the English state). The rewrite keys on the keystroke
 * position alone and sends backquote instead, so it needs no per-layout
 * knowledge. The gate (setting + macOS + Korean input source) is evaluated by
 * the caller before this resolver runs.
 */
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

/** Gate flags the caller resolves from live settings and the macOS input
 *  source tracker before consulting the resolver. */
export type TerminalKoreanWonInputOptions = {
  enabled: boolean
  isMac: boolean
  /** Whether the active macOS input source is a Korean keyboard (see korean-input-source.ts). */
  isKoreanKeyboard: boolean
}

/** 'input' feeds the translated character to xterm; 'suppress' swallows the
 *  companion keypress/keyup so the layout's own character cannot leak through. */
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

/** Resolves a terminal key event to a backquote input or a suppressed
 *  companion event, or null when the rewrite does not apply. */
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
