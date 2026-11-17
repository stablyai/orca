import { iterateOverDiff, type FileDiffMetadata } from '@pierre/diffs'
import type { DiffSearchMatch } from './pierre-diff-search'
import type { DiffSearchSide } from './PierreDiffSearchBar'

export const PIERRE_SEARCH_CSS = `
::highlight(orca-diff-find) { background-color: color-mix(in srgb, var(--markdown-search-match) 50%, transparent); color: inherit; }
::highlight(orca-diff-find-active) { background-color: color-mix(in srgb, var(--markdown-search-match-active) 60%, transparent); color: inherit; }
`
const highlights = new Map<symbol, { matches: Range[]; active: Range[] }>()

export function paintPierreSearchHighlights(
  owner: symbol,
  ranges?: { matches: Range[]; active: Range[] }
) {
  const previous = highlights.get(owner)
  if (ranges) {
    highlights.set(owner, ranges)
  } else {
    highlights.delete(owner)
  }
  if (typeof Highlight === 'undefined' || !CSS.highlights) {
    return
  }
  for (const [name, key] of [
    ['orca-diff-find', 'matches'],
    ['orca-diff-find-active', 'active']
  ] as const) {
    const highlight = CSS.highlights.get(name) ?? new Highlight()
    for (const range of previous?.[key] ?? []) {
      highlight.delete(range)
    }
    for (const range of ranges?.[key] ?? []) {
      highlight.add(range)
    }
    if (highlight.size) {
      CSS.highlights.set(name, highlight)
    } else {
      CSS.highlights.delete(name)
    }
  }
}

export function pierreRowTextRanges(
  row: HTMLElement,
  offsets: readonly { start: number; end: number }[]
): (Range | null)[] {
  const nodes: { node: Node; start: number; end: number }[] = []
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node: Node | null
  let offset = 0
  while ((node = walker.nextNode())) {
    const end = offset + (node.textContent?.length ?? 0)
    nodes.push({ node, start: offset, end })
    offset = end
  }
  let startIndex = 0
  let endIndex = 0
  return offsets.map(({ start, end }) => {
    while (startIndex < nodes.length && nodes[startIndex].end < start) {
      startIndex++
    }
    while (endIndex < nodes.length && nodes[endIndex].end < end) {
      endIndex++
    }
    const first = nodes[startIndex]
    const last = nodes[endIndex]
    if (!first || !last) {
      return null
    }
    const range = document.createRange()
    range.setStart(first.node, start - first.start)
    range.setEnd(last.node, end - last.start)
    return range
  })
}

export function pierreRowTextRange(row: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let started = false
  let node: Node | null
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0
    if (!started && offset + length >= start) {
      range.setStart(node, Math.max(0, start - offset))
      started = true
    }
    if (started && offset + length >= end) {
      range.setEnd(node, Math.max(0, end - offset))
      return range
    }
    offset += length
  }
  return null
}

export function getPierreSearchRanges(
  host: HTMLElement,
  diff: FileDiffMetadata,
  side: DiffSearchSide,
  matches: DiffSearchMatch[],
  active?: DiffSearchMatch
) {
  const rows = [
    ...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-code] [data-line]') ?? [])
  ]
  const split = Boolean(host.shadowRoot?.querySelector('[data-code][data-deletions]'))
  const indexPart = split ? 1 : 0
  const indexes = rows
    .map((row) => Number(row.dataset.lineIndex?.split(',')[indexPart]))
    .filter(Number.isFinite)
  const lineByIndex = new Map<number, number>()
  if (indexes.length) {
    iterateOverDiff({
      diff,
      diffStyle: split ? 'split' : 'unified',
      expandedHunks: true,
      startingLine: Math.min(...indexes),
      totalLines: Math.max(...indexes) - Math.min(...indexes) + 1,
      callback: ({ additionLine, deletionLine }) => {
        const line = side === 'additions' ? additionLine : deletionLine
        if (line) {
          lineByIndex.set(split ? line.splitLineIndex : line.unifiedLineIndex, line.lineNumber)
        }
      }
    })
  }
  const result: { matches: Range[]; active: Range[]; activeStart?: Range; activeEnd?: Range } = {
    matches: [],
    active: []
  }
  for (const row of rows) {
    if (split && !row.closest(`[data-code][data-${side}]`)) {
      continue
    }
    const line = lineByIndex.get(Number(row.dataset.lineIndex?.split(',')[indexPart]))
    if (line === undefined) {
      continue
    }
    // Matches are ordered, so only visit those intersecting this mounted row.
    let lo = 0,
      hi = matches.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (matches[mid].range.end.line < line - 1) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    for (let i = lo; i < matches.length && matches[i].range.start.line <= line - 1; i++) {
      const match = matches[i]
      const start = match.range.start.line === line - 1 ? match.range.start.character : 0
      const end =
        match.range.end.line === line - 1
          ? match.range.end.character
          : (row.textContent?.length ?? 0)
      const range = pierreRowTextRange(row, start, end)
      if (range) {
        result.matches.push(range)
        if (match === active) {
          result.active.push(range)
          if (match.range.start.line === line - 1) {
            result.activeStart = range
          }
          if (match.range.end.line === line - 1) {
            result.activeEnd = range
          }
        }
      }
    }
  }
  return result
}

export function pierreSearchRevealLine(
  diff: FileDiffMetadata,
  lineNumber: number,
  side: DiffSearchSide
): number {
  if (side === 'additions') {
    return lineNumber
  }
  // revealLine is new-file only; +0,0 (fully deleted) is range [1, 1), not 0.
  let modifiedLine = 1
  let found = false
  iterateOverDiff({
    diff,
    diffStyle: 'unified',
    expandedHunks: true,
    callback: ({ deletionLine, additionLine }): boolean => {
      if (additionLine) {
        modifiedLine = additionLine.lineNumber
      }
      if (deletionLine?.lineNumber === lineNumber) {
        found = true
      }
      return found && additionLine != null
    }
  })
  return modifiedLine
}
