import type { Locator } from '@playwright/test'

export async function diffTextSelectionPoints(code: Locator, text: string) {
  return code.evaluate(async (code, text) => {
    const content = code.querySelector('[data-content]')!
    const nodes: Text[] = []
    for (const row of content.querySelectorAll('[data-line]')) {
      if (nodes.length > 0 && !nodes.at(-1)!.data.endsWith('\n')) {
        // Pierre renders line breaks as separate rows rather than text nodes.
        nodes.push(document.createTextNode('\n'))
      }
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        nodes.push(walker.currentNode as Text)
      }
    }
    const contents = nodes.map((node) => node.data).join('')
    const start = contents.indexOf(text)
    if (start === -1) {
      throw new Error('Selection text is absent from the rendered diff')
    }
    const position = (offset: number) => {
      for (const node of nodes) {
        if (offset < node.length) {
          return { node, offset }
        }
        offset -= node.length
      }
      throw new Error('Selection endpoint is outside the rendered diff')
    }
    const glyph = (offset: number) => {
      const point = position(offset)
      const range = document.createRange()
      range.setStart(point.node, point.offset)
      range.setEnd(point.node, point.offset + 1)
      return range
    }
    const first = glyph(start)
    const last = glyph(start + text.length - 1)
    // Why: a short viewport (CI runs smaller than a dev window) can leave the target rows below
    // the fold, so the computed points hit whatever covers them instead of the diff.
    const rowOf = (range: Range) =>
      (range.startContainer.parentElement ?? null)?.closest('[data-line]') ?? null
    for (const row of [rowOf(last), rowOf(first)]) {
      // inline: 'nearest' — the default would scroll the row start under the sticky line-number column.
      row?.scrollIntoView({ block: 'center', inline: 'nearest' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    const viewport = code.getBoundingClientRect()
    const left = Math.min(first.getBoundingClientRect().left, last.getBoundingClientRect().left)
    const right = Math.max(first.getBoundingClientRect().right, last.getBoundingClientRect().right)
    // Why measured and not a constant: the line-number column is sticky, so centering the glyph in
    // a narrow pane slides it underneath the gutter and every point hit-tests as a line number.
    const gutter = code.querySelector('[data-line-number-content]')?.getBoundingClientRect()
    const inset = Math.max(24, gutter ? gutter.right - viewport.left + 8 : 0)
    code.scrollLeft += left - viewport.left - Math.max(inset, (viewport.width - (right - left)) / 2)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const point = (range: Range, end: boolean) => {
      const rect = range.getBoundingClientRect()
      const x = end ? rect.right - 0.5 : rect.left + 0.5
      const y = rect.top + rect.height / 2
      const root = code.getRootNode() as ShadowRoot
      const hit = root.elementFromPoint(x, y)
      if (!hit || !content.contains(hit) || document.elementFromPoint(x, y) !== root.host) {
        throw new Error('Selection endpoint is clipped or covered by another diff pane')
      }
      return { x, y }
    }
    return { start: point(first, false), end: point(last, true) }
  }, text)
}
