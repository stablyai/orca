const BLOCK_FG_VAR = '--orca-block-fg'
const FILL_ATTR = 'data-orca-block-fill'
// The span's inline color before the fill ('' when it had none), restored on clear.
const INLINE_FG_ATTR = 'data-orca-block-inline-fg'

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
  const originalColor = span.getAttribute(INLINE_FG_ATTR)
  // Any other inline color was set after the fill and is the span's current foreground.
  const ownsColor = span.style.color === 'transparent'
  span.removeAttribute(FILL_ATTR)
  span.removeAttribute(INLINE_FG_ATTR)
  span.style.removeProperty('background-image')
  span.style.removeProperty('background-size')
  span.style.removeProperty('background-repeat')
  span.style.removeProperty(BLOCK_FG_VAR)
  if (!ownsColor) {
    return
  }
  if (originalColor) {
    span.style.color = originalColor
  } else {
    span.style.removeProperty('color')
  }
}

type RenderedRows = { start: number; end: number }

export function applyDomBlockFills(root: ParentNode, range?: RenderedRows): void {
  if (typeof root.querySelectorAll !== 'function') {
    return
  }
  const rows = root.querySelector('.xterm-rows')
  if (!rows) {
    return
  }
  const start = range?.start ?? 0
  const end = Math.min(range?.end ?? rows.children.length - 1, rows.children.length - 1)
  for (let row = start; row <= end; row++) {
    fillBlockRow(rows.children[row]!)
  }
}

function fillBlockRow(row: Element): void {
  for (const span of row.querySelectorAll<HTMLElement>('span')) {
    fillBlockSpan(span)
  }
}

function fillBlockSpan(span: HTMLElement): void {
  const text = span.textContent ?? ''
  const fill = backgroundImageForUniformBlockRun(text)
  if (!fill) {
    clearBlockFill(span)
    return
  }
  const inlineFg = span.style.color
  const ownsColor = span.hasAttribute(FILL_ATTR) && inlineFg === 'transparent'
  if (ownsColor && span.getAttribute(FILL_ATTR) === text) {
    return
  }
  const fg = ownsColor
    ? span.style.getPropertyValue(BLOCK_FG_VAR)
    : inlineFg || (typeof getComputedStyle === 'function' ? getComputedStyle(span).color : '')
  if (!fg) {
    return
  }
  if (!ownsColor) {
    span.setAttribute(INLINE_FG_ATTR, inlineFg)
  }
  span.setAttribute(FILL_ATTR, text)
  span.style.setProperty(BLOCK_FG_VAR, fg)
  span.style.color = 'transparent'
  span.style.backgroundImage = fill
  span.style.backgroundSize = `${100 / text.length}% 100%`
  span.style.backgroundRepeat = 'repeat-x'
}

function collectAddedBlockRows(node: Node, rows: Set<HTMLElement>): void {
  if (!(node instanceof HTMLElement)) {
    return
  }
  if (node.parentElement?.classList.contains('xterm-rows')) {
    rows.add(node)
    return
  }
  const containers = node.matches('.xterm-rows') ? [node] : node.querySelectorAll('.xterm-rows')
  for (const container of containers) {
    for (const row of container.children) {
      if (row instanceof HTMLElement) {
        rows.add(row)
      }
    }
  }
}

export function attachDomBlockFill(terminal: { element?: HTMLElement | undefined }): () => void {
  const root = terminal.element
  if (!root || typeof MutationObserver === 'undefined') {
    return () => undefined
  }
  applyDomBlockFills(root)
  // DOM focus, selection and link paints replace rows without xterm's public onRender event.
  const observer = new MutationObserver((records) => {
    const rows = new Set<HTMLElement>()
    for (const record of records) {
      const row =
        record.target instanceof HTMLElement ? record.target.closest('.xterm-rows > div') : null
      if (row instanceof HTMLElement) {
        rows.add(row)
        continue
      }
      for (const node of record.addedNodes) {
        collectAddedBlockRows(node, rows)
      }
    }
    for (const row of rows) {
      if (root.contains(row)) {
        fillBlockRow(row)
      }
    }
  })
  observer.observe(root, { childList: true, subtree: true })
  return () => observer.disconnect()
}
