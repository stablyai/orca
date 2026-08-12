import React from 'react'
import { cn } from '@/lib/utils'
import { SpreadsheetChart } from './SpreadsheetChart'
import { SpreadsheetSparkline } from './SpreadsheetSparkline'
import {
  SPREADSHEET_ALIGNMENT_CLASSES,
  getSpreadsheetCellAlignmentClass
} from './spreadsheet-cell-alignment'
import type { SpreadsheetOverlayPlacements } from './spreadsheet-grid-overlay'

const VERTICAL_ALIGNMENT_CLASSES = {
  top: 'items-start',
  middle: 'items-center',
  bottom: 'items-end'
} as const

/**
 * The layer that floats charts, images, sparklines and merged text over the grid.
 *
 * Why a layer and not cells: each of these spans a cell range, and the grid tracks
 * the header and rows share must not be disturbed by it. It ignores pointer events
 * so the cells underneath stay hoverable.
 *
 * Merged text is here for the same reason, learned the hard way: a value in a
 * merge that spans rows is taller than any one row, and letting its cell overflow
 * downwards fought the virtualizer — each row carries a `transform` and is
 * therefore its own stacking context, so whichever of the two rows won the paint
 * order hid the other's row number.
 */
export function SpreadsheetGridOverlay({
  placements,
  fontSizePx,
  defaultVerticalAlignment = 'bottom'
}: {
  placements: SpreadsheetOverlayPlacements
  /** Rendered body font size, so merged text matches the cells around it. */
  fontSizePx?: number
  defaultVerticalAlignment?: 'top' | 'middle' | 'bottom'
}): React.JSX.Element | null {
  if (
    placements.drawings.length === 0 &&
    placements.sparklines.length === 0 &&
    placements.mergedTexts.length === 0
  ) {
    return null
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {placements.mergedTexts.map((placement) => (
        <div
          key={`merged-${placement.rowIndex}:${placement.columnIndex}`}
          // Why: the anchor cell carries this value as its aria-label, so
          // announcing it here too would repeat it.
          aria-hidden
          className={cn(
            'absolute flex overflow-hidden px-2',
            placement.style?.horizontalAlignment === undefined
              ? getSpreadsheetCellAlignmentClass(placement.text)
              : SPREADSHEET_ALIGNMENT_CLASSES[placement.style.horizontalAlignment],
            VERTICAL_ALIGNMENT_CLASSES[
              placement.style?.verticalAlignment ?? defaultVerticalAlignment
            ],
            placement.style?.wrapText === true && 'py-1 whitespace-pre-wrap break-words',
            placement.style?.bold === true && 'font-semibold',
            placement.style?.italic === true && 'italic'
          )}
          // Why: the band underneath already paints the fill, so only the ink and
          // the size are repeated here.
          style={{
            left: placement.left,
            top: placement.top,
            width: placement.width,
            height: placement.height,
            color: placement.style?.textColor,
            ...(fontSizePx === undefined || placement.style?.fontScale === undefined
              ? {}
              : { fontSize: Math.round(fontSizePx * placement.style.fontScale) })
          }}
        >
          <span className={placement.style?.wrapText === true ? 'min-w-0' : 'truncate'}>
            {placement.text}
          </span>
        </div>
      ))}
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
