import type { Locator, Page } from '@stablyai/playwright-test'

export function recoveredSessionPlaceholder(page: Page, paneKey: string): Locator {
  return page.locator(`[data-testid="recovered-session-placeholder"][data-pane-key="${paneKey}"]`)
}

/**
 * Names every rendered part of `surface` a user could not read or reach: an element past the
 * horizontal bounds (its pane, or the window for floating menus), text clipped by its box, a word
 * broken across lines, or a control another element covers.
 */
export function unusableParts(surface: Locator, bounds: 'pane' | 'window'): Promise<string[]> {
  return surface.evaluate((root, bounds) => {
    const limits =
      bounds === 'pane'
        ? root.parentElement!.getBoundingClientRect()
        : new DOMRect(0, 0, innerWidth)
    const problems: string[] = []
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (!(element instanceof HTMLElement) || !element.checkVisibility()) {
        continue
      }
      const name = element.textContent || element.getAttribute('aria-label') || element.tagName
      const box = element.getBoundingClientRect()
      if (box.left < limits.left - 0.5 || box.right > limits.right + 0.5) {
        problems.push(
          `${name}: outside [${limits.left}, ${limits.right}] at [${box.left}, ${box.right}]`
        )
      }
      if (element.scrollWidth > element.clientWidth) {
        problems.push(`${name}: clipped to ${element.clientWidth} of ${element.scrollWidth}px`)
      }
      if (element.matches('button, [role="menuitem"]')) {
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        if (!hit || !element.contains(hit)) {
          problems.push(`${name}: covered by ${hit?.outerHTML.slice(0, 160) ?? 'nothing'}`)
        }
      }
      for (const text of element.childNodes) {
        if (!(text instanceof Text)) {
          continue
        }
        for (const word of text.data.matchAll(/\S+/g)) {
          const range = document.createRange()
          range.setStart(text, word.index)
          range.setEnd(text, word.index + word[0].length)
          const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
          if (lines.size > 1) {
            problems.push(`${word[0]}: broken across ${lines.size} lines`)
          }
        }
      }
    }
    return problems
  }, bounds)
}
