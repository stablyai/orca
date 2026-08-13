import React from 'react'
import type { ResolvedXlsxSparkline } from './xlsx-sparkline'

type SpreadsheetSparklineProps = {
  sparkline: ResolvedXlsxSparkline
}

/**
 * Draws an in-cell sparkline, filling the cell it belongs to.
 *
 * The colours and the scale come from the formula the author wrote, including a
 * bound shared across sibling cells — two balance columns pinned to the same
 * `MAX` are meant to be compared, so each must not fill its own cell.
 */
const COLUMN_GAP_RATIO = 0.2
const LINE_WIDTH = 2
const SPARKLINE_INSET = 1

export function SpreadsheetSparkline({ sparkline }: SpreadsheetSparklineProps): React.JSX.Element {
  return (
    <svg
      className="size-full"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
      role="img"
      aria-label={buildLabel(sparkline)}
    >
      {renderMarks(sparkline)}
    </svg>
  )
}

function renderMarks(sparkline: ResolvedXlsxSparkline): React.JSX.Element {
  switch (sparkline.chartType) {
    case 'bar': {
      return <BarMarks sparkline={sparkline} />
    }
    case 'line': {
      return <LineMarks sparkline={sparkline} />
    }
    // Why: a win/loss plot is a column chart of equal-height marks that only
    // encodes sign, so it shares the column geometry with a fixed magnitude.
    case 'winloss':
    case 'column': {
      return <ColumnMarks sparkline={sparkline} />
    }
  }
}

function ColumnMarks({ sparkline }: SpreadsheetSparklineProps): React.JSX.Element {
  const isWinLoss = sparkline.chartType === 'winloss'
  const slot = 100 / Math.max(sparkline.values.length, 1)
  const gap = slot * COLUMN_GAP_RATIO

  return (
    <>
      {sparkline.values.map((value, index) => {
        const fraction = isWinLoss ? (value === 0 ? 0 : 0.5) : projectValue(value, sparkline)
        const height = Math.max(isWinLoss && value === 0 ? 0 : 1, fraction * 100)
        return (
          <rect
            key={index}
            x={slot * index + gap / 2}
            y={100 - height}
            width={Math.max(1, slot - gap)}
            height={height}
            fill={pickColor(sparkline, value, index)}
          >
            <title>{String(value)}</title>
          </rect>
        )
      })}
    </>
  )
}

function BarMarks({ sparkline }: SpreadsheetSparklineProps): React.JSX.Element {
  const slot = 100 / Math.max(sparkline.values.length, 1)

  return (
    <>
      {sparkline.values.map((value, index) => (
        <rect
          key={index}
          x={0}
          y={slot * index + SPARKLINE_INSET}
          width={Math.max(1, projectValue(value, sparkline) * 100)}
          height={Math.max(1, slot - SPARKLINE_INSET * 2)}
          fill={pickColor(sparkline, value, index)}
        >
          <title>{String(value)}</title>
        </rect>
      ))}
    </>
  )
}

function LineMarks({ sparkline }: SpreadsheetSparklineProps): React.JSX.Element {
  if (sparkline.values.length < 2) {
    return <ColumnMarks sparkline={sparkline} />
  }
  const step = 100 / (sparkline.values.length - 1)
  const points = sparkline.values
    .map((value, index) => `${step * index},${100 - projectValue(value, sparkline) * 100}`)
    .join(' ')

  return (
    <polyline
      points={points}
      fill="none"
      stroke={sparkline.color}
      strokeWidth={LINE_WIDTH}
      strokeLinejoin="round"
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  )
}

/** Fraction of the plot a value occupies, clamped into the author's own bounds. */
function projectValue(value: number, sparkline: ResolvedXlsxSparkline): number {
  const span = sparkline.max - sparkline.min
  if (span <= 0) {
    return value === 0 ? 0 : 1
  }
  return Math.min(1, Math.max(0, (value - sparkline.min) / span))
}

function pickColor(sparkline: ResolvedXlsxSparkline, value: number, index: number): string {
  if (value < 0 && sparkline.negativeColor !== undefined) {
    return sparkline.negativeColor
  }
  // Why: `firstcolor` names the first column specifically, which is how a
  // single-value sparkline carries its colour.
  return index === 0 && sparkline.firstColor !== undefined ? sparkline.firstColor : sparkline.color
}

function buildLabel(sparkline: ResolvedXlsxSparkline): string {
  return `${sparkline.chartType}: ${sparkline.values.join(', ')}`
}
