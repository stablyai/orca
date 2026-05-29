import type { GitHistoryGraphColorId, GitHistoryItem, GitHistoryItemRef } from './git-history'
import { GIT_HISTORY_REF_COLOR, GIT_HISTORY_REMOTE_REF_COLOR } from './git-history'
import type { GitHistoryGraphNode, GitHistoryItemViewModel } from './git-history-graph'

export const GIT_HISTORY_INCOMING_CHANGES_ID = 'git-history-incoming-changes'
export const GIT_HISTORY_OUTGOING_CHANGES_ID = 'git-history-outgoing-changes'

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

function hasNode(
  nodes: readonly GitHistoryGraphNode[],
  id: string,
  color?: GitHistoryGraphColorId
): boolean {
  return nodes.some((node) => node.id === id && (color === undefined || node.color === color))
}

function remoteBoundaryInputNode(
  node: GitHistoryGraphNode,
  mergeBase: string
): GitHistoryGraphNode {
  return node.id === mergeBase && node.color === GIT_HISTORY_REMOTE_REF_COLOR
    ? { ...node, id: GIT_HISTORY_INCOMING_CHANGES_ID }
    : cloneNode(node)
}

function ensureIncomingRemoteLane(
  inputSwimlanes: GitHistoryGraphNode[],
  outputSwimlanes: GitHistoryGraphNode[],
  mergeBase: string
): void {
  // Why: HEAD-only history omits upstream commits, so the graph must still
  // synthesize the remote lane that used to arrive from those hidden rows.
  if (!hasNode(outputSwimlanes, mergeBase, GIT_HISTORY_REMOTE_REF_COLOR)) {
    const localMergeBaseIndex = outputSwimlanes.findIndex(
      (node) => node.id === mergeBase && node.color === GIT_HISTORY_REF_COLOR
    )
    const remoteMergeBaseIndex =
      localMergeBaseIndex === -1 ? inputSwimlanes.length : localMergeBaseIndex + 1
    outputSwimlanes.splice(remoteMergeBaseIndex, 0, {
      id: mergeBase,
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
  }

  if (hasNode(inputSwimlanes, GIT_HISTORY_INCOMING_CHANGES_ID, GIT_HISTORY_REMOTE_REF_COLOR)) {
    return
  }

  const remoteMergeBaseIndex = outputSwimlanes.findIndex(
    (node) => node.id === mergeBase && node.color === GIT_HISTORY_REMOTE_REF_COLOR
  )
  inputSwimlanes.splice(
    remoteMergeBaseIndex === -1 ? inputSwimlanes.length : remoteMergeBaseIndex,
    0,
    { id: GIT_HISTORY_INCOMING_CHANGES_ID, color: GIT_HISTORY_REMOTE_REF_COLOR }
  )
}

export function addIncomingOutgoingChangesHistoryItems(
  viewModels: GitHistoryItemViewModel[],
  currentRef?: GitHistoryItemRef,
  remoteRef?: GitHistoryItemRef,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string
): void {
  if (currentRef?.revision === remoteRef?.revision || !mergeBase) {
    return
  }

  if (addIncomingChanges && remoteRef && remoteRef.revision !== mergeBase) {
    addIncomingChangesHistoryItem(viewModels, remoteRef, mergeBase)
  }

  if (addOutgoingChanges && currentRef?.revision && currentRef.revision !== mergeBase) {
    addOutgoingChangesHistoryItem(viewModels, currentRef)
  }
}

function addIncomingChangesHistoryItem(
  viewModels: GitHistoryItemViewModel[],
  remoteRef: GitHistoryItemRef,
  mergeBase: string
): void {
  const beforeHistoryItemIndex = findLastIndex(viewModels, (viewModel) =>
    viewModel.outputSwimlanes.some((node) => node.id === mergeBase)
  )
  const afterHistoryItemIndex = viewModels.findIndex(
    (viewModel) => viewModel.historyItem.id === mergeBase
  )
  if (afterHistoryItemIndex === -1) {
    return
  }

  const before = beforeHistoryItemIndex !== -1 ? viewModels[beforeHistoryItemIndex] : undefined
  const incomingChangeMerged =
    before?.historyItem.parentIds.length === 2 && before.historyItem.parentIds.includes(mergeBase)
  if (incomingChangeMerged) {
    return
  }

  const after = viewModels[afterHistoryItemIndex] as GitHistoryItemViewModel
  const inputSwimlanes =
    before?.outputSwimlanes.map((node) => remoteBoundaryInputNode(node, mergeBase)) ??
    after.inputSwimlanes.map(cloneNode)
  const outputSwimlanes = after.inputSwimlanes.map(cloneNode)
  ensureIncomingRemoteLane(inputSwimlanes, outputSwimlanes, mergeBase)

  if (before !== undefined) {
    viewModels[beforeHistoryItemIndex] = {
      ...before,
      inputSwimlanes: before.inputSwimlanes.map((node) => remoteBoundaryInputNode(node, mergeBase)),
      outputSwimlanes: inputSwimlanes.map(cloneNode)
    }
  }

  const displayIdLength = viewModels[0]?.historyItem.displayId?.length ?? 0
  const incomingChangesHistoryItem: GitHistoryItem = {
    id: GIT_HISTORY_INCOMING_CHANGES_ID,
    displayId: '0'.repeat(displayIdLength),
    parentIds: [mergeBase],
    author: remoteRef.name,
    subject: 'Incoming Changes',
    message: ''
  }

  viewModels.splice(afterHistoryItemIndex, 0, {
    historyItem: incomingChangesHistoryItem,
    kind: 'incoming-changes',
    inputSwimlanes,
    outputSwimlanes
  })

  viewModels[afterHistoryItemIndex + 1] = {
    ...after,
    inputSwimlanes: outputSwimlanes.map(cloneNode)
  }
}

function addOutgoingChangesHistoryItem(
  viewModels: GitHistoryItemViewModel[],
  currentRef: GitHistoryItemRef
): void {
  const currentRevision = currentRef.revision
  if (!currentRevision) {
    return
  }

  const currentRefIndex = viewModels.findIndex(
    (viewModel) => viewModel.kind === 'HEAD' && viewModel.historyItem.id === currentRevision
  )
  if (currentRefIndex === -1) {
    return
  }

  const displayIdLength = viewModels[0]?.historyItem.displayId?.length ?? 0
  const outgoingChangesHistoryItem: GitHistoryItem = {
    id: GIT_HISTORY_OUTGOING_CHANGES_ID,
    displayId: '0'.repeat(displayIdLength),
    parentIds: [currentRevision],
    author: currentRef.name,
    subject: 'Outgoing Changes',
    message: ''
  }

  const inputSwimlanes = viewModels[currentRefIndex]!.inputSwimlanes.map(cloneNode)
  const outputSwimlanes = inputSwimlanes.concat({
    id: currentRevision,
    color: GIT_HISTORY_REF_COLOR
  })

  viewModels.splice(currentRefIndex, 0, {
    historyItem: outgoingChangesHistoryItem,
    kind: 'outgoing-changes',
    inputSwimlanes,
    outputSwimlanes
  })

  viewModels[currentRefIndex + 1]!.inputSwimlanes.push({
    id: currentRevision,
    color: GIT_HISTORY_REF_COLOR
  })
}
