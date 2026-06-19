import type { GitHistoryGraphColorId, GitHistoryItem, GitHistoryItemRef } from './git-history'
import {
  GIT_HISTORY_INCOMING_CHANGES_ID,
  GIT_HISTORY_OUTGOING_CHANGES_ID,
  addIncomingOutgoingChangesHistoryItems
} from './git-history-boundary-rows'
import {
  GIT_HISTORY_BASE_REF_COLOR,
  GIT_HISTORY_LANE_COLORS,
  GIT_HISTORY_REF_COLOR,
  GIT_HISTORY_REMOTE_REF_COLOR
} from './git-history'

export { GIT_HISTORY_INCOMING_CHANGES_ID, GIT_HISTORY_OUTGOING_CHANGES_ID }

export type GitHistoryGraphNode = {
  id: string
  color: GitHistoryGraphColorId
}

export type GitHistoryItemViewModel = {
  historyItem: GitHistoryItem
  inputSwimlanes: GitHistoryGraphNode[]
  outputSwimlanes: GitHistoryGraphNode[]
  kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes'
}

function rotate(index: number, length: number): number {
  return ((index % length) + length) % length
}

function cloneNode(node: GitHistoryGraphNode): GitHistoryGraphNode {
  return { id: node.id, color: node.color }
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) {
      return index
    }
  }
  return -1
}

function findLastNodeIndex(nodes: readonly GitHistoryGraphNode[], id: string): number {
  return findLastIndex(nodes, (node) => node.id === id)
}

function getLabelColorIdentifier(
  historyItem: GitHistoryItem,
  colorMap: Map<string, GitHistoryGraphColorId | undefined>
): GitHistoryGraphColorId | undefined {
  if (historyItem.id === GIT_HISTORY_INCOMING_CHANGES_ID) {
    return GIT_HISTORY_REMOTE_REF_COLOR
  }
  if (historyItem.id === GIT_HISTORY_OUTGOING_CHANGES_ID) {
    return GIT_HISTORY_REF_COLOR
  }
  for (const ref of historyItem.references ?? []) {
    const color = colorMap.get(ref.id)
    if (color !== undefined) {
      return color
    }
  }
  return undefined
}

export function compareGitHistoryRefs(
  ref1: GitHistoryItemRef,
  ref2: GitHistoryItemRef,
  currentRef?: GitHistoryItemRef,
  remoteRef?: GitHistoryItemRef,
  baseRef?: GitHistoryItemRef
): number {
  const order = (ref: GitHistoryItemRef): number => {
    if (ref.id === currentRef?.id) {
      return 1
    }
    if (ref.id === remoteRef?.id) {
      return 2
    }
    if (ref.id === baseRef?.id) {
      return 3
    }
    if (ref.color !== undefined) {
      return 4
    }
    return 99
  }

  return order(ref1) - order(ref2)
}

export function buildGitHistoryViewModels(
  historyItems: GitHistoryItem[],
  colorMap = new Map<string, GitHistoryGraphColorId | undefined>(),
  currentRef?: GitHistoryItemRef,
  remoteRef?: GitHistoryItemRef,
  baseRef?: GitHistoryItemRef,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string
): GitHistoryItemViewModel[] {
  let colorIndex = -1
  const viewModels: GitHistoryItemViewModel[] = []

  for (const historyItem of historyItems) {
    const kind = historyItem.id === currentRef?.revision ? 'HEAD' : 'node'
    const inputSwimlanes = (viewModels.at(-1)?.outputSwimlanes ?? []).map(cloneNode)
    const outputSwimlanes: GitHistoryGraphNode[] = []
    let firstParentAdded = false

    if (historyItem.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === historyItem.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: historyItem.parentIds[0]!,
              color: getLabelColorIdentifier(historyItem, colorMap) ?? node.color
            })
            firstParentAdded = true
          }
          continue
        }
        outputSwimlanes.push(cloneNode(node))
      }
    }

    for (let index = firstParentAdded ? 1 : 0; index < historyItem.parentIds.length; index += 1) {
      let colorIdentifier: GitHistoryGraphColorId | undefined
      if (index === 0) {
        colorIdentifier = getLabelColorIdentifier(historyItem, colorMap)
      } else {
        const parent = historyItems.find((item) => item.id === historyItem.parentIds[index])
        colorIdentifier = parent ? getLabelColorIdentifier(parent, colorMap) : undefined
      }

      if (!colorIdentifier) {
        colorIndex = rotate(colorIndex + 1, GIT_HISTORY_LANE_COLORS.length)
        colorIdentifier = GIT_HISTORY_LANE_COLORS[colorIndex]!
      }

      outputSwimlanes.push({
        id: historyItem.parentIds[index]!,
        color: colorIdentifier
      })
    }

    const references = (historyItem.references ?? [])
      .map((ref) => {
        let color = colorMap.get(ref.id)
        if (colorMap.has(ref.id) && color === undefined) {
          const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)
          const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length
          color =
            circleIndex < outputSwimlanes.length
              ? outputSwimlanes[circleIndex]!.color
              : circleIndex < inputSwimlanes.length
                ? inputSwimlanes[circleIndex]!.color
                : GIT_HISTORY_REF_COLOR
        }
        return { ...ref, color }
      })
      .sort((ref1, ref2) => compareGitHistoryRefs(ref1, ref2, currentRef, remoteRef, baseRef))

    viewModels.push({
      historyItem: { ...historyItem, references },
      kind,
      inputSwimlanes,
      outputSwimlanes
    })
  }

  addIncomingOutgoingChangesHistoryItems(
    viewModels,
    currentRef,
    remoteRef,
    addIncomingChanges,
    addOutgoingChanges,
    mergeBase
  )

  return viewModels
}

export function getGitHistoryItemLaneIndex(viewModel: GitHistoryItemViewModel): number {
  const inputIndex = viewModel.inputSwimlanes.findIndex(
    (node) => node.id === viewModel.historyItem.id
  )
  return inputIndex !== -1 ? inputIndex : viewModel.inputSwimlanes.length
}

export function getGitHistoryMergeParentLaneIndex(
  viewModel: GitHistoryItemViewModel,
  parentId: string
): number {
  return findLastNodeIndex(viewModel.outputSwimlanes, parentId)
}

export function buildDefaultGitHistoryColorMap(input: {
  currentRef?: GitHistoryItemRef
  remoteRef?: GitHistoryItemRef
  baseRef?: GitHistoryItemRef
}): Map<string, GitHistoryGraphColorId | undefined> {
  const colorMap = new Map<string, GitHistoryGraphColorId | undefined>()
  if (input.currentRef) {
    colorMap.set(input.currentRef.id, GIT_HISTORY_REF_COLOR)
  }
  if (input.remoteRef) {
    colorMap.set(input.remoteRef.id, GIT_HISTORY_REMOTE_REF_COLOR)
  }
  if (input.baseRef) {
    colorMap.set(input.baseRef.id, GIT_HISTORY_BASE_REF_COLOR)
  }
  return colorMap
}
