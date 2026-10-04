import { paragraphRunIndexes } from './pdf-text-blocks'
/** A rect in the scroll container's content box, so overlays scroll with the pages. */
export type PdfContentRect = { x: number; y: number; width: number; height: number }

/** Client point inside the scroll container's content box, so overlays scroll with the pages. */
export function clientToContentPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = container.getBoundingClientRect()
  return {
    x: clientX - rect.left + container.scrollLeft,
    y: clientY - rect.top + container.scrollTop
  }
}

/** pdf.js text-layer runs; markedContent spans are structural wrappers without their own text. */
export const TEXT_RUN_SELECTOR = '.textLayer span:not(.markedContent)'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** The client box from a drag's start to `(x, y)`, clamped to the page it started on. */
export function dragRectOnPage(
  pageDiv: Element,
  startX: number,
  startY: number,
  x: number,
  y: number
): DOMRect {
  const page = pageDiv.getBoundingClientRect()
  const endX = clamp(x, page.left, page.right)
  const endY = clamp(y, page.top, page.bottom)
  return new DOMRect(
    Math.min(startX, endX),
    Math.min(startY, endY),
    Math.abs(endX - startX),
    Math.abs(endY - startY)
  )
}

/** The box spanning two opposite corners in either order (rotated pages swap which is top-left). */
export function rectBetweenCorners(
  a: { x: number; y: number },
  b: { x: number; y: number }
): PdfContentRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

export function contentRectBetween(
  container: HTMLElement,
  a: { x: number; y: number },
  b: { x: number; y: number }
): PdfContentRect {
  const start = clientToContentPoint(container, Math.min(a.x, b.x), Math.min(a.y, b.y))
  return { ...start, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** Same "covers half" rule as SyncTeX line picking, so the quote matches the reported lines. */
function coversGlyph(glyph: DOMRect, rect: DOMRect): boolean {
  const cx = glyph.left + glyph.width / 2
  const overlapY = Math.min(glyph.bottom, rect.bottom) - Math.max(glyph.top, rect.top)
  return cx >= rect.left && cx <= rect.right && overlapY >= glyph.height / 2
}

// Latin-script word characters only; CJK has no spaces, so snapping would swallow whole sentences.
const WORD_CHAR_RE = /[A-Za-z0-9\u00C0-\u024F]/

/**
 * Widens each picked span to whole words where the box edge cut a word in half.
 * `chars` are code points, so astral glyphs (e.g. math italic 𝑥) keep indexes aligned.
 */
export function snapToWords(chars: readonly string[], picked: readonly boolean[]): string {
  const snapped = [...picked]
  chars.forEach((char, index) => {
    if (!picked[index] || !WORD_CHAR_RE.test(char)) {
      return
    }
    for (let left = index - 1; left >= 0 && WORD_CHAR_RE.test(chars[left]); left -= 1) {
      snapped[left] = true
    }
    for (
      let right = index + 1;
      right < chars.length && WORD_CHAR_RE.test(chars[right]);
      right += 1
    ) {
      snapped[right] = true
    }
  })
  return chars.filter((_, index) => snapped[index]).join('')
}

// Why: a run is often a whole line, so a box around one word must be cut per character.
function runTextInRect(run: Element, rect: DOMRect): string {
  const node = run.firstChild
  const text = node?.textContent ?? ''
  if (!(node instanceof Text) || text.length === 0) {
    return coversGlyph(run.getBoundingClientRect(), rect) ? text : ''
  }
  const range = document.createRange()
  const chars = [...text]
  const picked: boolean[] = []
  let offset = 0
  for (const char of chars) {
    range.setStart(node, offset)
    range.setEnd(node, offset + char.length)
    picked.push(coversGlyph(range.getBoundingClientRect(), rect))
    offset += char.length
  }
  return snapToWords(chars, picked)
}

/** Text under a client rect, in text-layer order. Math may come out garbled. */
export function textInClientRect(pageDiv: HTMLElement, rect: DOMRect): string | null {
  const parts: string[] = []
  for (const run of pageDiv.querySelectorAll(TEXT_RUN_SELECTOR)) {
    const box = run.getBoundingClientRect()
    if (
      box.right < rect.left ||
      box.left > rect.right ||
      box.bottom < rect.top ||
      box.top > rect.bottom
    ) {
      continue
    }
    const text = runTextInRect(run, rect).trim()
    if (text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join(' ') : null
}

/** The paragraph around a text run: its client box and text, for hover and click picking. */
export function paragraphAt(
  target: Element
): { pageDiv: HTMLElement; rect: DOMRect; text: string } | null {
  const run = target.closest(TEXT_RUN_SELECTOR)
  const pageDiv = target.closest<HTMLElement>('.page[data-page-number]')
  if (!run || !pageDiv) {
    return null
  }
  const runs = [...pageDiv.querySelectorAll(TEXT_RUN_SELECTOR)].filter((r) => r.textContent?.trim())
  const hit = runs.indexOf(run)
  if (hit === -1) {
    return null
  }
  const boxes = runs.map((r) => r.getBoundingClientRect())
  const picked = paragraphRunIndexes(boxes, hit)
  const left = Math.min(...picked.map((i) => boxes[i].left))
  const top = Math.min(...picked.map((i) => boxes[i].top))
  const right = Math.max(...picked.map((i) => boxes[i].right))
  const bottom = Math.max(...picked.map((i) => boxes[i].bottom))
  const text = picked.map((i) => runs[i].textContent?.trim() ?? '').join(' ')
  return { pageDiv, rect: new DOMRect(left, top, right - left, bottom - top), text }
}

export function joinQuotes(a: string | null, b: string | null): string | null {
  return a && b ? `${a} … ${b}` : (a ?? b)
}
