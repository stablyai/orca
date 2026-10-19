import React, { useMemo } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { RenderRow } from '../listing/render-row'
import {
  buildProjectGroupColorBands,
  buildRowProjectGroupColors,
  getProjectGroupTint
} from './project-group-color-bands'

// Paints each colored project group's section behind its rows, header through last workspace.
export function ProjectGroupColorBandLayer({
  renderRows,
  projectGroups,
  virtualItems
}: {
  renderRows: readonly RenderRow[]
  projectGroups: readonly ProjectGroup[]
  virtualItems: readonly VirtualItem[]
}): React.JSX.Element | null {
  const rowColors = useMemo(
    () => buildRowProjectGroupColors(renderRows, projectGroups),
    [renderRows, projectGroups]
  )
  const bands = buildProjectGroupColorBands(rowColors, virtualItems)
  if (bands.length === 0) {
    return null
  }
  return (
    <>
      {bands.map((band) => (
        <div
          key={band.key}
          aria-hidden
          data-project-group-color-band=""
          className="pointer-events-none absolute left-0 right-1 rounded-lg"
          style={{
            top: band.top,
            height: band.height,
            backgroundColor: getProjectGroupTint(band.color, 9),
            boxShadow: `inset 2px 0 0 ${getProjectGroupTint(band.color, 70)}`
          }}
        />
      ))}
    </>
  )
}
