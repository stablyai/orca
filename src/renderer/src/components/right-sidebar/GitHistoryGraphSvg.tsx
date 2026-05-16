import React from 'react'
import type { GitHistoryGraphColorId } from '../../../../shared/git-history'
import {
  getGitHistoryItemLaneIndex,
  getGitHistoryMergeParentLaneIndex,
  type GitHistoryItemViewModel
} from '../../../../shared/git-history-graph'

const SWIMLANE_HEIGHT = 22
const SWIMLANE_WIDTH = 11
const SWIMLANE_CURVE_RADIUS = 5
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
  const inputSwimlanes = viewModel.inputSwimlanes
  const outputSwimlanes = viewModel.outputSwimlanes
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)
  const circleIndex = getGitHistoryItemLaneIndex(viewModel)
  const circleColor =
    circleIndex < outputSwimlanes.length
      ? outputSwimlanes[circleIndex]!.color
      : circleIndex < inputSwimlanes.length
        ? inputSwimlanes[circleIndex]!.color
        : 'git-graph-ref'

  const paths: React.JSX.Element[] = []
  let outputSwimlaneIndex = 0

  for (let index = 0; index < inputSwimlanes.length; index += 1) {
    const color = inputSwimlanes[index]!.color
    if (inputSwimlanes[index]!.id === historyItem.id) {
      if (index !== circleIndex) {
        paths.push(
          <GraphPath
            key={`base-${index}`}
            color={color}
            d={[
              `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
              `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`,
              `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`
            ].join(' ')}
          />
        )
      } else {
        outputSwimlaneIndex += 1
      }
      continue
    }

    if (
      outputSwimlaneIndex < outputSwimlanes.length &&
      inputSwimlanes[index]!.id === outputSwimlanes[outputSwimlaneIndex]!.id
    ) {
      if (index === outputSwimlaneIndex) {
        paths.push(
          <GraphPath
            key={`vertical-${index}`}
            color={color}
            d={`M ${SWIMLANE_WIDTH * (index + 1)} 0 V ${SWIMLANE_HEIGHT}`}
          />
        )
      } else {
        paths.push(
          <GraphPath
            key={`shift-${index}-${outputSwimlaneIndex}`}
            color={color}
            d={[
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
            ].join(' ')}
          />
        )
      }
      outputSwimlaneIndex += 1
    }
  }

  for (let index = 1; index < historyItem.parentIds.length; index += 1) {
    const parentId = historyItem.parentIds[index]!
    const parentOutputIndex = getGitHistoryMergeParentLaneIndex(viewModel, parentId)
    if (parentOutputIndex === -1) {
      continue
    }
    paths.push(
      <GraphPath
        key={`merge-parent-${index}`}
        color={outputSwimlanes[parentOutputIndex]!.color}
        d={[
          `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
          `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`,
          `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
          `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`
        ].join(' ')}
      />
    )
  }

  if (inputIndex !== -1) {
    paths.push(
      <GraphPath
        key="into-node"
        color={inputSwimlanes[inputIndex]!.color}
        d={`M ${SWIMLANE_WIDTH * (circleIndex + 1)} 0 V ${SWIMLANE_HEIGHT / 2}`}
      />
    )
  }
  if (historyItem.parentIds.length > 0) {
    paths.push(
      <GraphPath
        key="out-of-node"
        color={circleColor}
        d={`M ${SWIMLANE_WIDTH * (circleIndex + 1)} ${SWIMLANE_HEIGHT / 2} V ${SWIMLANE_HEIGHT}`}
      />
    )
  }

  const cx = SWIMLANE_WIDTH * (circleIndex + 1)
  const cy = SWIMLANE_WIDTH
  const width = SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1)
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
