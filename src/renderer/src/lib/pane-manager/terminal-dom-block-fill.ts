/**
 * GPU Off uses xterm's DOM renderer, which paints box/block glyphs from the
 * font. OpenCode's composer bottom is a run of ▀; the font glyph does not fill
 * the cell, so a 1px terminal-background hairline shows through. WebGL custom
 * glyphs fill the cell. Approximate that for uniform block runs with a CSS
 * gradient on the span (height: 100% of the row).
 */

const BLOCK_FG_VAR = '--orca-block-fg'
const FILL_ATTR = 'data-orca-block-fill'
const FG_ATTR = 'data-orca-block-fg'

function gradient(axis: 'bottom' | 'right', solidPercent: number, fromStart: boolean): string {
  const dir = axis === 'bottom' ? 'to bottom' : 'to right'
  const fg = `var(${BLOCK_FG_VAR})`
  if (fromStart) {
    return `linear-gradient(${dir}, ${fg} ${solidPercent}%, transparent ${solidPercent}%)`
  }
  const gap = 100 - solidPercent
  return `linear-gradient(${dir}, transparent ${gap}%, ${fg} ${gap}%)`
}

/** CSS background-image that fills the cell the way WebGL custom glyphs do. */
export function backgroundImageForUniformBlockRun(text: string): string | null {
  if (text.length === 0) {
    return null
  }
  const ch = text[0]!
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== ch) {
      return null
    }
  }
  const code = ch.codePointAt(0) ?? 0
  if (code === 0x2580) {
    return gradient('bottom', 50, true)
  }
  if (code >= 0x2581 && code <= 0x2588) {
    const eighths = code - 0x2580
    return gradient('bottom', eighths * 12.5, false)
  }
  if (code >= 0x2589 && code <= 0x258f) {
    const eighths = 8 - (code - 0x2588)
    return gradient('right', eighths * 12.5, true)
  }
  if (code === 0x2590) {
    return gradient('right', 50, false)
  }
  if (code === 0x2594) {
    return gradient('bottom', 12.5, true)
  }
  if (code === 0x2595) {
    return gradient('right', 12.5, false)
  }
  return null
}

function clearBlockFill(span: HTMLElement): void {
  if (!span.hasAttribute(FILL_ATTR)) {
    return
  }
  const originalColor = span.getAttribute(FG_ATTR)
  span.removeAttribute(FILL_ATTR)
  span.removeAttribute(FG_ATTR)
  span.style.removeProperty('background-image')
  span.style.removeProperty('background-size')
  span.style.removeProperty('background-repeat')
  span.style.removeProperty(BLOCK_FG_VAR)
  if (originalColor) {
    span.style.color = originalColor
  } else {
    span.style.removeProperty('color')
  }
}

export function applyDomBlockFills(root: ParentNode): void {
  if (typeof root.querySelectorAll !== 'function') {
    return
  }
  const spans = root.querySelectorAll('.xterm-rows span')
  for (const node of spans) {
    const span = node as HTMLElement
    const text = span.textContent ?? ''
    const fill = backgroundImageForUniformBlockRun(text)
    if (!fill) {
      clearBlockFill(span)
      continue
    }
    if (span.getAttribute(FILL_ATTR) === text) {
      continue
    }
    const fg =
      span.getAttribute(FG_ATTR) ||
      span.style.color ||
      (typeof getComputedStyle === 'function' ? getComputedStyle(span).color : '')
    if (!fg) {
      continue
    }
    span.setAttribute(FG_ATTR, fg)
    span.setAttribute(FILL_ATTR, text)
    span.style.setProperty(BLOCK_FG_VAR, fg)
    span.style.color = 'transparent'
    span.style.backgroundImage = fill
    span.style.backgroundSize = `${100 / text.length}% 100%`
    span.style.backgroundRepeat = 'repeat-x'
  }
}

export function attachDomBlockFill(terminal: {
  onRender?: (cb: () => void) => { dispose: () => void }
  element?: HTMLElement | undefined
}): () => void {
  const run = (): void => {
    const root = terminal.element
    if (root) {
      applyDomBlockFills(root)
    }
  }
  const schedule = (): void => {
    run()
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run)
    }
  }
  schedule()
  const renderDisposable =
    typeof terminal.onRender === 'function'
      ? terminal.onRender(schedule)
      : { dispose: () => undefined }

  let observer: MutationObserver | null = null
  const root = terminal.element
  if (
    typeof Node !== 'undefined' &&
    root instanceof Node &&
    typeof MutationObserver === 'function'
  ) {
    observer = new MutationObserver(schedule)
    observer.observe(root, { childList: true, subtree: true })
  }

  return () => {
    renderDisposable.dispose()
    observer?.disconnect()
  }
}
