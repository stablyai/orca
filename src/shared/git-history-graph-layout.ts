import type { GitHistoryGraphColorId } from './git-history'
import {
  getGitHistoryItemColor,
  getGitHistoryItemLaneIndex,
  getGitHistoryMergeParentLaneIndex,
  type GitHistoryItemViewModel
} from './git-history-graph'

export type GitHistoryGraphGeometry = {
  laneWidth: number
  rowHeight: number
  curveRadius: number
}

export type GitHistoryGraphPath = {
  key: string
  d: string
  color: GitHistoryGraphColorId
}

export type GitHistoryGraphRowLayout = {
  paths: GitHistoryGraphPath[]
  cx: number
  cy: number
  width: number
  nodeColor: GitHistoryGraphColorId
}

// The graph column's width for a row touching `laneCount` lanes.
export function gitHistoryGraphWidth(laneCount: number, laneWidth: number): number {
  return laneWidth * (Math.max(laneCount, 1) + 1)
}

// One row's swimlane paths, so desktop SVG and mobile react-native-svg draw the same graph.
export function layoutGitHistoryGraphRow(
  viewModel: GitHistoryItemViewModel,
  geometry: GitHistoryGraphGeometry
): GitHistoryGraphRowLayout {
  const { laneWidth: width, rowHeight: height, curveRadius: radius } = geometry
  const nodeY = height / 2
  const historyItem = viewModel.historyItem
  const inputSwimlanes = viewModel.inputSwimlanes
  const outputSwimlanes = viewModel.outputSwimlanes
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)
  const circleIndex = getGitHistoryItemLaneIndex(viewModel)
  const nodeColor = getGitHistoryItemColor(viewModel)

  const paths: GitHistoryGraphPath[] = []
  let outputSwimlaneIndex = 0

  for (let index = 0; index < inputSwimlanes.length; index += 1) {
    const color = inputSwimlanes[index]!.color
    if (inputSwimlanes[index]!.id === historyItem.id) {
      if (index !== circleIndex) {
        paths.push({
          key: `base-${inputSwimlanes[index]!.id}`,
          color,
          d: [
            `M ${width * (index + 1)} 0`,
            `A ${width} ${width} 0 0 1 ${width * index} ${nodeY}`,
            `H ${width * (circleIndex + 1)}`
          ].join(' ')
        })
      } else if (historyItem.parentIds.length > 0) {
        outputSwimlaneIndex += 1
      }
      continue
    }

    if (
      outputSwimlaneIndex < outputSwimlanes.length &&
      inputSwimlanes[index]!.id === outputSwimlanes[outputSwimlaneIndex]!.id
    ) {
      if (index === outputSwimlaneIndex) {
        paths.push({
          key: `vertical-${inputSwimlanes[index]!.id}`,
          color,
          d: `M ${width * (index + 1)} 0 V ${height}`
        })
      } else {
        paths.push({
          key: `shift-${inputSwimlanes[index]!.id}-${outputSwimlanes[outputSwimlaneIndex]!.id}`,
          color,
          d: [
            `M ${width * (index + 1)} 0`,
            `V ${nodeY / 2}`,
            `A ${radius} ${radius} 0 0 1 ${width * (index + 1) - radius} ${nodeY}`,
            `H ${width * (outputSwimlaneIndex + 1) + radius}`,
            `A ${radius} ${radius} 0 0 0 ${width * (outputSwimlaneIndex + 1)} ${nodeY + radius}`,
            `V ${height}`
          ].join(' ')
        })
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
    paths.push({
      key: `merge-parent-${parentId}`,
      color: outputSwimlanes[parentOutputIndex]!.color,
      d: [
        `M ${width * parentOutputIndex} ${nodeY}`,
        `A ${width} ${width} 0 0 1 ${width * (parentOutputIndex + 1)} ${height}`,
        `M ${width * parentOutputIndex} ${nodeY}`,
        `H ${width * (circleIndex + 1)}`
      ].join(' ')
    })
  }

  if (inputIndex !== -1) {
    paths.push({
      key: 'into-node',
      color: inputSwimlanes[inputIndex]!.color,
      d: `M ${width * (circleIndex + 1)} 0 V ${nodeY}`
    })
  }
  if (historyItem.parentIds.length > 0) {
    paths.push({
      key: 'out-of-node',
      color: nodeColor,
      d: `M ${width * (circleIndex + 1)} ${nodeY} V ${height}`
    })
  }

  return {
    paths,
    cx: width * (circleIndex + 1),
    cy: nodeY,
    width: gitHistoryGraphWidth(Math.max(inputSwimlanes.length, outputSwimlanes.length), width),
    nodeColor
  }
}
