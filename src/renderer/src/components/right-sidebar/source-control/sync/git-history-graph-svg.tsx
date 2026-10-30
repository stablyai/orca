import React from 'react'
import type { GitHistoryGraphColorId } from '../../../../../../shared/git-history'
import type { GitHistoryItemViewModel } from '../../../../../../shared/git-history-graph'
import { layoutGitHistoryGraphRow } from '../../../../../../shared/git-history-graph-layout'

const SWIMLANE_HEIGHT = 24
const GRAPH_GEOMETRY = { laneWidth: 11, rowHeight: SWIMLANE_HEIGHT, curveRadius: 5 }
const CIRCLE_RADIUS = 3.5
const CIRCLE_STROKE_WIDTH = 1.5

export function graphColor(color: GitHistoryGraphColorId): string {
  return `var(--${color})`
}

function GraphPath({
  d,
  color,
  strokeWidth = 1
}: {
  d: string
  color: GitHistoryGraphColorId
  strokeWidth?: number
}): React.JSX.Element {
  return (
    <path
      d={d}
      fill="none"
      stroke={graphColor(color)}
      strokeLinecap="round"
      strokeWidth={strokeWidth}
    />
  )
}

export function GitHistoryGraphSvg({
  viewModel
}: {
  viewModel: GitHistoryItemViewModel
}): React.JSX.Element {
  const historyItem = viewModel.historyItem
  const {
    paths: layoutPaths,
    cx,
    cy,
    width,
    nodeColor: circleColor
  } = layoutGitHistoryGraphRow(viewModel, GRAPH_GEOMETRY)
  const paths = layoutPaths.map((path) => (
    <GraphPath key={path.key} d={path.d} color={path.color} />
  ))
  const isBoundaryNode =
    viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
  const isMergeNode = historyItem.parentIds.length > 1

  return (
    <svg
      aria-hidden="true"
      className="shrink-0 overflow-visible"
      width={width}
      height={SWIMLANE_HEIGHT}
      viewBox={`0 0 ${width} ${SWIMLANE_HEIGHT}`}
    >
      {paths}
      {viewModel.kind === 'HEAD' && (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={CIRCLE_RADIUS + 3}
            fill={graphColor(circleColor)}
            stroke="var(--background)"
            strokeWidth={CIRCLE_STROKE_WIDTH}
          />
          <circle cx={cx} cy={cy} r={CIRCLE_STROKE_WIDTH} fill="var(--background)" />
        </>
      )}
      {isBoundaryNode && (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={CIRCLE_RADIUS + 3}
            fill={graphColor(circleColor)}
            stroke="var(--background)"
            strokeWidth={CIRCLE_STROKE_WIDTH}
          />
          <circle
            cx={cx}
            cy={cy}
            r={CIRCLE_RADIUS + 1}
            fill="var(--background)"
            stroke="var(--background)"
            strokeWidth={CIRCLE_STROKE_WIDTH + 1}
          />
          <circle
            cx={cx}
            cy={cy}
            r={CIRCLE_RADIUS + 1}
            fill="none"
            stroke={graphColor(circleColor)}
            strokeDasharray="4 2"
            strokeWidth={CIRCLE_STROKE_WIDTH - 1}
          />
        </>
      )}
      {!isBoundaryNode && viewModel.kind !== 'HEAD' && isMergeNode && (
        <>
          <circle cx={cx} cy={cy} r={CIRCLE_RADIUS + 1} fill={graphColor(circleColor)} />
          <circle cx={cx} cy={cy} r={CIRCLE_RADIUS - 1.5} fill="var(--background)" />
        </>
      )}
      {!isBoundaryNode && viewModel.kind !== 'HEAD' && !isMergeNode && (
        <circle cx={cx} cy={cy} r={CIRCLE_RADIUS} fill={graphColor(circleColor)} />
      )}
    </svg>
  )
}
