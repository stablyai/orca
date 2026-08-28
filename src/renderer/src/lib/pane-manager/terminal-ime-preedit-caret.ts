/**
 * Draws the terminal's own cursor at the end of an in-flight IME preedit.
 *
 * Why: xterm's `.composition-view` is opaque and sits on the cell the renderer
 * draws the cursor in, so while a CJK syllable composes there is no cursor
 * anywhere — it reappears only once the syllable commits, or when the pane
 * loses focus and the overlay closes. The overlay is DOM and the cursor is
 * canvas, so the real one cannot show through; this mirrors it in DOM, matching
 * the pane's configured style, blink, and cell size.
 *
 * A real element rather than a `::after`: the pseudo-element computed correctly
 * but never painted inside this overlay, and a node we own is verifiable.
 */

const CARET_CLASS = 'orca-ime-preedit-caret'
const BLINK_CLASS = 'orca-ime-preedit-caret-blink'

type CaretStyle = 'block' | 'bar' | 'underline'

/** Only the cursor settings this needs, so a pane double does not have to be a
 *  whole Terminal to exercise the caret. */
export type PreeditCaretCursorOptions = {
  cursorStyle?: string
  cursorBlink?: boolean
  /** xterm's resolved theme; `cursor` already carries the configured opacity. */
  theme?: { cursor?: string }
}

function resolveCaretStyle(options: PreeditCaretCursorOptions | undefined): CaretStyle {
  // Not cursorInactiveStyle: a composing pane is focused by definition, so the
  // active style is the one the user would otherwise be looking at.
  switch (options?.cursorStyle) {
    case 'bar':
      return 'bar'
    case 'underline':
      return 'underline'
    default:
      return 'block'
  }
}

function ensureCaret(compositionView: HTMLElement): HTMLElement {
  const caret =
    compositionView.querySelector<HTMLElement>(`.${CARET_CLASS}`) ?? document.createElement('span')
  caret.className = CARET_CLASS
  caret.setAttribute('aria-hidden', 'true')
  // Why the direction check, and why in flow at all: the overlay does not paint
  // absolutely-positioned children that fall outside its box, so the caret has
  // to be a normal inline box — and xterm gives the view `direction: rtl` with
  // an isolate, under which the *first* child is the rightmost one. Both calls
  // move an existing node, which is what re-seats the caret after xterm rewrites
  // the view's text on every update.
  if (getComputedStyle(compositionView).direction === 'rtl') {
    compositionView.prepend(caret)
  } else {
    compositionView.append(caret)
  }
  return caret
}

/**
 * Applies caret geometry to the composition view. Cell metrics come from the
 * caller so both IME overlays measure the screen once per composition.
 */
export function applyTerminalImePreeditCaret(
  compositionView: HTMLElement,
  options: PreeditCaretCursorOptions | undefined,
  cellWidth: number,
  cellHeight: number
): void {
  const caret = ensureCaret(compositionView)
  const style = resolveCaretStyle(options)
  const width = style === 'bar' ? Math.max(1, Math.round(cellWidth / 8)) : cellWidth
  const height = style === 'underline' ? Math.max(1, Math.round(cellHeight / 8)) : cellHeight

  caret.classList.toggle(BLINK_CLASS, options?.cursorBlink === true)
  // The pane's own cursor colour, not the overlay's foreground: the two happen
  // to match in the default theme and diverge in every other one. Empty falls
  // back to the stylesheet's currentcolor for a pane with no theme.
  caret.style.background = options?.theme?.cursor ?? ''
  caret.style.width = `${width}px`
  caret.style.height = `${height}px`
  caret.style.marginTop = style === 'underline' ? `${cellHeight - height}px` : '0px'
}
