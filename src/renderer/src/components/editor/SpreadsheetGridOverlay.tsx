import React from 'react'
import { SpreadsheetChart } from './SpreadsheetChart'
import { SpreadsheetSparkline } from './SpreadsheetSparkline'
import type { SpreadsheetOverlayPlacements } from './spreadsheet-grid-overlay'

/**
 * The layer that floats charts, images and sparklines over the grid.
 *
 * Why a layer and not cells: each of these spans a cell range, and the grid tracks
 * the header and rows share must not be disturbed by it. It ignores pointer events
 * so the cells underneath stay hoverable.
 */
export function SpreadsheetGridOverlay({
  placements
}: {
  placements: SpreadsheetOverlayPlacements
}): React.JSX.Element | null {
  if (placements.drawings.length === 0 && placements.sparklines.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {placements.sparklines.map((placement, index) => (
        <div
          key={`sparkline-${index}`}
          className="absolute"
          style={{
            left: placement.left,
            top: placement.top,
            width: placement.width,
            height: placement.height
          }}
        >
          <SpreadsheetSparkline sparkline={placement.sparkline} />
        </div>
      ))}
      {placements.drawings.map((placement, index) => (
        <div
          key={`drawing-${index}`}
          className="absolute"
          style={{
            left: placement.left,
            top: placement.top,
            width: placement.width,
            height: placement.height
          }}
        >
          {placement.drawing.kind === 'chart' ? (
            <SpreadsheetChart
              chart={placement.drawing.chart}
              width={placement.width}
              height={placement.height}
            />
          ) : (
            <img
              src={placement.drawing.source}
              alt={placement.drawing.description ?? ''}
              className="size-full object-contain"
            />
          )}
        </div>
      ))}
    </div>
  )
}
