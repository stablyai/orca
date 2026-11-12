import React from 'react'
import type { GitHistoryGraphColorId } from '../../../../../../shared/git/history/git-history-types'
import {
  getGitHistoryItemColor,
  getGitHistoryItemLaneIndex,
  type GitHistoryItemViewModel
} from '../../../../../../shared/git/history/git-history-graph'

const SWIMLANE_HEIGHT = 24
const SWIMLANE_WIDTH = 11
const SWIMLANE_CURVE_RADIUS = 5
const SWIMLANE_NODE_Y = SWIMLANE_HEIGHT / 2
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
  viewModel,
  visibleWidth
}: {
  viewModel: GitHistoryItemViewModel
  visibleWidth?: number
}): React.JSX.Element {
  const historyItem = viewModel.historyItem
  const inputSwimlanes = viewModel.inputSwimlanes
  const outputSwimlanes = viewModel.outputSwimlanes
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)
  const circleIndex = getGitHistoryItemLaneIndex(viewModel)
  const circleColor = getGitHistoryItemColor(viewModel)
  const intersects = (left: number, right: number, extent = 0.5): boolean =>
    visibleWidth === undefined || (right + extent >= 0 && left - extent <= visibleWidth)

  const paths: { d: string; color: GitHistoryGraphColorId }[] = []
  let outputSwimlaneIndex = 0

  for (let index = 0; index < inputSwimlanes.length; index += 1) {
    const color = inputSwimlanes[index]!.color
    if (inputSwimlanes[index]!.id === historyItem.id) {
      if (
        index !== circleIndex &&
        intersects(
          SWIMLANE_WIDTH * Math.min(index, circleIndex + 1),
          SWIMLANE_WIDTH * (index + 1),
          SWIMLANE_WIDTH + 0.5
        )
      ) {
        paths.push({
          color,
          d: [
            `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
            `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_NODE_Y}`,
            `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`
          ].join(' ')
        })
      } else if (index === circleIndex && historyItem.parentIds.length > 0) {
        outputSwimlaneIndex += 1
      }
      continue
    }

    if (
      outputSwimlaneIndex < outputSwimlanes.length &&
      inputSwimlanes[index]!.id === outputSwimlanes[outputSwimlaneIndex]!.id
    ) {
      if (
        index === outputSwimlaneIndex &&
        intersects(SWIMLANE_WIDTH * (index + 1), SWIMLANE_WIDTH * (index + 1))
      ) {
        paths.push({
          color,
          d: `M ${SWIMLANE_WIDTH * (index + 1)} 0 V ${SWIMLANE_HEIGHT}`
        })
      } else if (
        index !== outputSwimlaneIndex &&
        intersects(
          SWIMLANE_WIDTH * Math.min(index + 1, outputSwimlaneIndex + 1),
          SWIMLANE_WIDTH * Math.max(index + 1, outputSwimlaneIndex + 1),
          SWIMLANE_CURVE_RADIUS + 0.5
        )
      ) {
        paths.push({
          color,
          d: [
            `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
            'V 6',
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${
              SWIMLANE_WIDTH * (index + 1) - SWIMLANE_CURVE_RADIUS
            } ${SWIMLANE_HEIGHT / 2}`,
            `H ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1) + SWIMLANE_CURVE_RADIUS}`,
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${
              SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)
            } ${SWIMLANE_HEIGHT / 2 + SWIMLANE_CURVE_RADIUS}`,
            `V ${SWIMLANE_HEIGHT}`
          ].join(' ')
        })
      }
      outputSwimlaneIndex += 1
    }
  }

  const parentOutputIndices =
    historyItem.parentIds.length > 1 ? new Map<string, number>() : undefined
  if (parentOutputIndices) {
    for (let index = 0; index < outputSwimlanes.length; index += 1) {
      parentOutputIndices.set(outputSwimlanes[index]!.id, index)
    }
  }
  for (let index = 1; index < historyItem.parentIds.length; index += 1) {
    const parentId = historyItem.parentIds[index]!
    const parentOutputIndex = parentOutputIndices!.get(parentId)
    if (
      parentOutputIndex === undefined ||
      !intersects(
        SWIMLANE_WIDTH * Math.min(parentOutputIndex, circleIndex + 1),
        SWIMLANE_WIDTH * Math.max(parentOutputIndex + 1, circleIndex + 1),
        SWIMLANE_WIDTH + 0.5
      )
    ) {
      continue
    }
    paths.push({
      color: outputSwimlanes[parentOutputIndex]!.color,
      d: [
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
        `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`,
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
        `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`
      ].join(' ')
    })
  }

  const cx = SWIMLANE_WIDTH * (circleIndex + 1)
  if (inputIndex !== -1 && intersects(cx, cx)) {
    paths.push({
      color: inputSwimlanes[inputIndex]!.color,
      d: `M ${SWIMLANE_WIDTH * (circleIndex + 1)} 0 V ${SWIMLANE_HEIGHT / 2}`
    })
  }
  if (historyItem.parentIds.length > 0 && intersects(cx, cx)) {
    paths.push({
      color: circleColor,
      d: `M ${SWIMLANE_WIDTH * (circleIndex + 1)} ${SWIMLANE_HEIGHT / 2} V ${SWIMLANE_HEIGHT}`
    })
  }

  const cy = SWIMLANE_NODE_Y
  const width = SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1)
  const isBoundaryNode =
    viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
  const isMergeNode = historyItem.parentIds.length > 1
  const circleExtent =
    isBoundaryNode || viewModel.kind === 'HEAD'
      ? CIRCLE_RADIUS + 3 + CIRCLE_STROKE_WIDTH / 2
      : isMergeNode
        ? CIRCLE_RADIUS + 1
        : CIRCLE_RADIUS
  const showCircle = intersects(cx, cx, circleExtent)

  return (
    <svg
      aria-hidden="true"
      className="shrink-0 overflow-visible"
      width={width}
      height={SWIMLANE_HEIGHT}
      viewBox={`0 0 ${width} ${SWIMLANE_HEIGHT}`}
    >
      {paths.map((path) => (
        <GraphPath key={path.d} d={path.d} color={path.color} />
      ))}
      {showCircle && viewModel.kind === 'HEAD' && (
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
      {showCircle && isBoundaryNode && (
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
      {showCircle && !isBoundaryNode && viewModel.kind !== 'HEAD' && isMergeNode && (
        <>
          <circle cx={cx} cy={cy} r={CIRCLE_RADIUS + 1} fill={graphColor(circleColor)} />
          <circle cx={cx} cy={cy} r={CIRCLE_RADIUS - 1.5} fill="var(--background)" />
        </>
      )}
      {showCircle && !isBoundaryNode && viewModel.kind !== 'HEAD' && !isMergeNode && (
        <circle cx={cx} cy={cy} r={CIRCLE_RADIUS} fill={graphColor(circleColor)} />
      )}
    </svg>
  )
}
