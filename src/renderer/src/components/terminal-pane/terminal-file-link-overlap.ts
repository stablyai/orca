import type { ILink } from '@xterm/xterm'
import type { WrappedLogicalLine } from './wrapped-terminal-link-ranges'

export type ProvidedFileLink = {
  link: ILink
  logicalLine: WrappedLogicalLine
}

function rangesOverlap(left: ILink['range'], right: ILink['range']): boolean {
  const leftStartsAfterRightEnds =
    left.start.y > right.end.y || (left.start.y === right.end.y && left.start.x > right.end.x)
  const rightStartsAfterLeftEnds =
    right.start.y > left.end.y || (right.start.y === left.end.y && right.start.x > left.end.x)
  return !leftStartsAfterRightEnds && !rightStartsAfterLeftEnds
}

export function preferLongestNonOverlappingLinks(links: ProvidedFileLink[]): ProvidedFileLink[] {
  const selected: ProvidedFileLink[] = []
  const byLengthDescending = [...links].sort(
    (a, b) =>
      b.link.text.length - a.link.text.length ||
      a.link.range.start.y - b.link.range.start.y ||
      a.link.range.start.x - b.link.range.start.x
  )
  for (const link of byLengthDescending) {
    if (!selected.some((existing) => rangesOverlap(existing.link.range, link.link.range))) {
      selected.push(link)
    }
  }
  return selected.sort(
    (a, b) =>
      a.link.range.start.y - b.link.range.start.y || a.link.range.start.x - b.link.range.start.x
  )
}
