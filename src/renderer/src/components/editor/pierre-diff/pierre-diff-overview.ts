import { createContext } from 'react'
import {
  VirtualizedFileDiff,
  Virtualizer,
  type FileDiffMetadata,
  type SelectionSide
} from '@pierre/diffs'
import type { PierreDiffInstance } from './PierreDiffSurface'

export type DiffOverviewMarker = { top: number; height: number; side: SelectionSide }
export type DiffOverviewGeometry = { height: number; markers: DiffOverviewMarker[] }
export type DiffOverviewSource = DiffOverviewGeometry & {
  original: string
  modified: string
  inset: number
  layout: string
}
export const PierreDiffOverviewContext = createContext<{
  publish: (path: string, source: DiffOverviewSource) => void
} | null>(null)

export function getDiffOverviewGeometry(
  diff: FileDiffMetadata,
  instance: Pick<PierreDiffInstance, 'getLinePosition' | 'getRenderedLinePositions'>,
  height: number
): DiffOverviewGeometry {
  const targets: { lineNumber: number; side: SelectionSide }[] = []
  for (const hunk of diff.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== 'change') {
        continue
      }
      for (const side of ['deletions', 'additions'] as const) {
        if (!content[side]) {
          continue
        }
        const start =
          (side === 'additions' ? content.additionLineIndex : content.deletionLineIndex) + 1
        targets.push({ lineNumber: start, side }, { lineNumber: start + content[side] - 1, side })
      }
    }
  }
  const positions = instance.getRenderedLinePositions?.(targets)
  const position = (line: number, side: SelectionSide) =>
    positions ? positions.get(`${side}:${line}`) : instance.getLinePosition?.(line, side)
  const markers: DiffOverviewMarker[] = []
  for (const hunk of diff.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== 'change') {
        continue
      }
      for (const side of ['deletions', 'additions'] as const) {
        const count = content[side]
        if (!count) {
          continue
        }
        const start =
          (side === 'additions' ? content.additionLineIndex : content.deletionLineIndex) + 1
        const first = position(start, side)
        const last = position(start + count - 1, side)
        if (first && last) {
          markers.push({ top: first.top, height: last.top + last.height - first.top, side })
        }
      }
    }
  }
  return { height, markers }
}

// Use Pierre's own collapsed-row geometry before a section has ever mounted.
export function estimateDiffOverview(
  diff: FileDiffMetadata,
  sideBySide: boolean
): DiffOverviewGeometry {
  const instance = new VirtualizedFileDiff(
    {
      diffStyle: sideBySide ? 'split' : 'unified',
      disableFileHeader: true
    },
    new Virtualizer()
  )
  const height = instance.updateCodeViewLayout(diff, 0)
  return getDiffOverviewGeometry(diff, instance, height)
}
