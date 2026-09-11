import type { Locator } from '@playwright/test'

export async function diffTextSelectionPoints(code: Locator, text: string) {
  return code.evaluate(async (code, text) => {
    // Why re-queried: if the upgrade replaces the container rather than its rows, a cached
    // reference walks a detached tree and never matches again.
    const contentEl = () => code.querySelector('[data-content]')!
    const collect = () => {
      const found: Text[] = []
      for (const row of contentEl().querySelectorAll('[data-line]')) {
        if (found.length > 0 && !found.at(-1)!.data.endsWith('\n')) {
          // Pierre renders line breaks as separate rows rather than text nodes.
          found.push(document.createTextNode('\n'))
        }
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          found.push(walker.currentNode as Text)
        }
      }
      return found
    }
    let nodes = collect()
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
    let first = glyph(start)
    let last = glyph(start + text.length - 1)
    // Why: a short viewport (CI runs smaller than a dev window) can leave the target rows below
    // the fold, so the computed points hit whatever covers them instead of the diff.
    const rowOf = (range: Range) =>
      (range.startContainer.parentElement ?? null)?.closest('[data-line]') ?? null
    for (const row of [rowOf(last), rowOf(first)]) {
      // inline: 'nearest' — the default would scroll the row start under the sticky line-number column.
      row?.scrollIntoView({ block: 'center', inline: 'nearest' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    // Why after the scroll waits and not before them: the highlight upgrade replaces a row's
    // nodes at an arbitrary frame after first paint. Checking before these awaits passes with
    // fresh nodes, and the upgrade then detaches them during the very frames above, so every
    // later measurement reads an all-zero rect.
    let settled = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (
        first.getBoundingClientRect().width > 0 &&
        last.getBoundingClientRect().width > 0 &&
        code.contains(first.startContainer) &&
        code.contains(last.startContainer)
      ) {
        settled = true
        break
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      nodes = collect()
      const reindexed = nodes
        .map((node) => node.data)
        .join('')
        .indexOf(text)
      if (reindexed === -1) {
        continue
      }
      first = glyph(reindexed)
      last = glyph(reindexed + text.length - 1)
    }
    if (!settled) {
      // Why named: otherwise this surfaces below as a clipping error reporting a zero-width
      // glyph, which misattributes a detached node to pane geometry.
      throw new Error('Selection glyphs never settled: the rendered nodes kept being replaced')
    }
    const viewport = code.getBoundingClientRect()
    const left = Math.min(first.getBoundingClientRect().left, last.getBoundingClientRect().left)
    const right = Math.max(first.getBoundingClientRect().right, last.getBoundingClientRect().right)
    // Why measured and not a constant: the line-number column is sticky, so centering the glyph
    // in a narrow pane slides it under the gutter and every point hit-tests as a line number.
    // Why a filtered max and not the first: a side-by-side pane stacks two sticky number columns,
    // so the first alone leaves the glyph under the second -- but an unfiltered max picks up
    // number cells scrolled far to the right and overshoots.
    const gutterRight = [...code.querySelectorAll('[data-line-number-content]')].reduce(
      (widest, node) => {
        const box = node.getBoundingClientRect()
        return box.right < viewport.left + viewport.width / 2 ? Math.max(widest, box.right) : widest
      },
      0
    )
    const inset = Math.max(24, gutterRight > 0 ? gutterRight - viewport.left + 8 : 0)
    code.scrollLeft += left - viewport.left - Math.max(inset, (viewport.width - (right - left)) / 2)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const point = (range: Range, end: boolean) => {
      const rect = range.getBoundingClientRect()
      const x = end ? rect.right - 0.5 : rect.left + 0.5
      const y = rect.top + rect.height / 2
      const root = code.getRootNode() as ShadowRoot
      const hit = root.elementFromPoint(x, y)
      if (!hit || !contentEl().contains(hit) || document.elementFromPoint(x, y) !== root.host) {
        // Why the detail: this only reproduces on displays narrower than a dev machine, so the
        // numbers have to come back from the runner rather than be guessed at locally.
        const pane = code.getBoundingClientRect()
        throw new Error(
          `Selection endpoint is clipped or covered by another diff pane: ${JSON.stringify({
            point: { x: Math.round(x), y: Math.round(y), isEnd: end },
            glyph: { left: Math.round(rect.left), right: Math.round(rect.right) },
            pane: { left: Math.round(pane.left), width: Math.round(pane.width) },
            selectionWidth: Math.round(right - left),
            inset: Math.round(inset),
            scrollLeft: Math.round(code.scrollLeft),
            window: { width: window.innerWidth, height: window.innerHeight },
            hit: hit ? hit.tagName : null,
            hitInContent: hit ? contentEl().contains(hit) : false
          })}`
        )
      }
      return { x, y }
    }
    return { start: point(first, false), end: point(last, true) }
  }, text)
}
