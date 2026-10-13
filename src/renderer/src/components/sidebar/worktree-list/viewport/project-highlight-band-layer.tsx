import { useMemo } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import {
  getProjectHighlightBands,
  getProjectHighlightSections,
  getProjectHighlightStyle
} from './project-highlight-bands'

/** Painted behind the virtual rows so one band spans a project's header, cards and row gaps. */
export function useProjectHighlightBands(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy,
  firstHeaderIndex: number,
  virtualization: {
    virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, 'getVirtualItems' | 'measurementsCache'>
  }
): React.ReactNode {
  const virtualItems = virtualization.virtualizer.getVirtualItems()
  const sections = useMemo(() => getProjectHighlightSections(rows, groupBy), [rows, groupBy])
  if (sections.length === 0 || virtualItems.length === 0) {
    return null
  }
  const bands = getProjectHighlightBands({
    sections,
    rows,
    firstHeaderIndex,
    measurements: virtualization.virtualizer.measurementsCache,
    visibleStartIndex: Math.min(...virtualItems.map((item) => item.index)),
    visibleEndIndex: Math.max(...virtualItems.map((item) => item.index))
  })
  return bands.map((band) => (
    <div
      key={band.key}
      aria-hidden
      data-project-highlight-band
      className="worktree-project-highlight pointer-events-none absolute left-0 right-0 rounded-md"
      style={{ ...getProjectHighlightStyle(band.color), top: band.top, height: band.height }}
    />
  ))
}
