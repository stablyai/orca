import { describe, expect, it } from 'vitest'
import type { GitHistoryItem, GitHistoryItemRef } from './git-history'
import {
  GIT_HISTORY_BASE_REF_COLOR,
  GIT_HISTORY_LANE_COLORS,
  GIT_HISTORY_REF_COLOR,
  GIT_HISTORY_REMOTE_REF_COLOR
} from './git-history'
import {
  GIT_HISTORY_INCOMING_CHANGES_ID,
  GIT_HISTORY_OUTGOING_CHANGES_ID,
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels,
  getGitHistoryMergeParentLaneIndex
} from './git-history-graph'

function item(
  id: string,
  parentIds: string[],
  references: GitHistoryItemRef[] = []
): GitHistoryItem {
  return {
    id,
    parentIds,
    subject: id,
    message: id,
    displayId: id,
    references
  }
}

function trackedItem(id: string, parentIds: string[], reads: { count: number }): GitHistoryItem {
  const result = item(id, parentIds)
  Object.defineProperty(result, 'id', {
    configurable: true,
    enumerable: true,
    get: () => {
      reads.count += 1
      return id
    }
  })
  return result
}

function branch(name: string, revision: string): GitHistoryItemRef {
  return {
    id: `refs/heads/${name}`,
    name,
    revision,
    category: 'branches'
  }
}

function remote(name: string, revision: string): GitHistoryItemRef {
  return {
    id: `refs/remotes/${name}`,
    name,
    revision,
    category: 'remote branches'
  }
}

describe('git history graph model', () => {
  it('preserves the current branch lane through linear history', () => {
    const currentRef = branch('main', 'A')
    const viewModels = buildGitHistoryViewModels(
      [item('A', ['B'], [currentRef]), item('B', ['C']), item('C', [])],
      buildDefaultGitHistoryColorMap({ currentRef }),
      currentRef
    )

    expect(viewModels.map((viewModel) => viewModel.kind)).toEqual(['HEAD', 'node', 'node'])
    expect(viewModels[0]!.inputSwimlanes).toEqual([])
    expect(viewModels[0]!.outputSwimlanes).toEqual([{ id: 'B', color: GIT_HISTORY_REF_COLOR }])
    expect(viewModels[1]!.inputSwimlanes).toEqual([{ id: 'B', color: GIT_HISTORY_REF_COLOR }])
    expect(viewModels[1]!.outputSwimlanes).toEqual([{ id: 'C', color: GIT_HISTORY_REF_COLOR }])
    expect(viewModels[0]!.historyItem.references?.[0]?.color).toBe(GIT_HISTORY_REF_COLOR)
  })

  it('allocates a side lane for a merge parent', () => {
    const currentRef = branch('feature', 'M')
    const viewModels = buildGitHistoryViewModels(
      [item('M', ['A', 'B'], [currentRef]), item('A', ['C']), item('B', ['C']), item('C', [])],
      buildDefaultGitHistoryColorMap({ currentRef }),
      currentRef
    )

    expect(viewModels[0]!.kind).toBe('HEAD')
    expect(viewModels[0]!.outputSwimlanes).toEqual([
      { id: 'A', color: GIT_HISTORY_REF_COLOR },
      { id: 'B', color: GIT_HISTORY_LANE_COLORS[0] }
    ])
    expect(getGitHistoryMergeParentLaneIndex(viewModels[0]!, 'B')).toBe(1)
  })

  it('keeps the first matching parent when history contains duplicate ids', () => {
    const headRef = branch('head', 'merge')
    const firstParentRef = branch('first', 'duplicate')
    const laterParentRef = remote('later', 'duplicate')
    const colorMap = buildDefaultGitHistoryColorMap({
      currentRef: headRef,
      remoteRef: firstParentRef,
      baseRef: laterParentRef
    })
    const viewModels = buildGitHistoryViewModels(
      [
        item('merge', ['base', 'duplicate'], [headRef]),
        item('base', []),
        item('duplicate', [], [firstParentRef]),
        item('duplicate', [], [laterParentRef])
      ],
      colorMap,
      headRef
    )

    expect(viewModels[0]!.outputSwimlanes[1]!.color).toBe(GIT_HISTORY_REMOTE_REF_COLOR)
  })

  it('avoids building a parent index for linear history', () => {
    const count = 64
    const reads = { count: 0 }
    const historyItems = Array.from({ length: count }, (_, index) =>
      trackedItem(`commit-${index}`, index + 1 < count ? [`commit-${index + 1}`] : [], reads)
    )

    buildGitHistoryViewModels(historyItems)

    // A linear graph reads each item while projecting; an eager index would add one read per row.
    expect(reads.count).toBeLessThanOrEqual(count * 5)
  })

  it('indexes merge parents once instead of rescanning a large history', () => {
    const mergeCount = 64
    const targetId = `target-${mergeCount}`
    const reads = { count: 0 }
    const historyItems: GitHistoryItem[] = []
    for (let index = 0; index < mergeCount; index += 1) {
      historyItems.push(trackedItem(`merge-${index}`, [`missing-${index}`, targetId], reads))
      // Reset swimlanes between merges so this measures parent lookup, not lane growth.
      historyItems.push(trackedItem(`leaf-${index}`, [], reads))
    }
    historyItems.push(trackedItem(targetId, [], reads))

    buildGitHistoryViewModels(historyItems)

    // Repeated Array#find scans grow with rows; one index build stays within a linear read budget.
    expect(reads.count).toBeLessThan(historyItems.length * 8)
  })

  it('inserts incoming and outgoing boundary rows at the merge base', () => {
    const currentRef = branch('feature', 'A')
    const remoteRef = remote('origin/feature', 'R')
    const viewModels = buildGitHistoryViewModels(
      [
        item('A', ['B'], [currentRef]),
        item('R', ['B'], [remoteRef]),
        item('B', ['C']),
        item('C', [])
      ],
      buildDefaultGitHistoryColorMap({ currentRef, remoteRef }),
      currentRef,
      remoteRef,
      undefined,
      true,
      true,
      'B'
    )

    expect(viewModels.map((viewModel) => viewModel.kind)).toEqual([
      'outgoing-changes',
      'HEAD',
      'node',
      'incoming-changes',
      'node',
      'node'
    ])
    expect(viewModels[0]!.historyItem.id).toBe(GIT_HISTORY_OUTGOING_CHANGES_ID)
    expect(viewModels[3]!.historyItem.id).toBe(GIT_HISTORY_INCOMING_CHANGES_ID)
    expect(viewModels[3]!.inputSwimlanes).toContainEqual({
      id: GIT_HISTORY_INCOMING_CHANGES_ID,
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
  })

  it('inserts an incoming boundary when HEAD-only history is behind upstream', () => {
    const currentRef = branch('feature', 'B')
    const remoteRef = remote('origin/feature', 'R')
    const viewModels = buildGitHistoryViewModels(
      [item('B', ['C'], [currentRef]), item('C', [])],
      buildDefaultGitHistoryColorMap({ currentRef, remoteRef }),
      currentRef,
      remoteRef,
      undefined,
      true,
      false,
      'B'
    )

    expect(viewModels.map((viewModel) => viewModel.kind)).toEqual([
      'incoming-changes',
      'HEAD',
      'node'
    ])
    expect(viewModels[0]!.inputSwimlanes).toContainEqual({
      id: GIT_HISTORY_INCOMING_CHANGES_ID,
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
    expect(viewModels[0]!.outputSwimlanes).toContainEqual({
      id: 'B',
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
    expect(viewModels[1]!.inputSwimlanes).toContainEqual({
      id: 'B',
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
    const incomingLaneIndex = viewModels[0]!.inputSwimlanes.findIndex(
      (node) => node.id === GIT_HISTORY_INCOMING_CHANGES_ID
    )
    expect(viewModels[0]!.outputSwimlanes[incomingLaneIndex]?.color).toBe(
      GIT_HISTORY_REMOTE_REF_COLOR
    )
  })

  it('colors incoming boundary lanes as remote when upstream commits are omitted', () => {
    const currentRef = branch('feature', 'A')
    const remoteRef = remote('origin/feature', 'R')
    const viewModels = buildGitHistoryViewModels(
      [item('A', ['B'], [currentRef]), item('B', ['C']), item('C', [])],
      buildDefaultGitHistoryColorMap({ currentRef, remoteRef }),
      currentRef,
      remoteRef,
      undefined,
      true,
      true,
      'B'
    )

    expect(viewModels.map((viewModel) => viewModel.kind)).toEqual([
      'outgoing-changes',
      'HEAD',
      'incoming-changes',
      'node',
      'node'
    ])
    expect(viewModels[2]!.inputSwimlanes).toContainEqual({
      id: GIT_HISTORY_INCOMING_CHANGES_ID,
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
    expect(viewModels[2]!.outputSwimlanes).toContainEqual({
      id: 'B',
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
    expect(viewModels[3]!.inputSwimlanes).toContainEqual({
      id: 'B',
      color: GIT_HISTORY_REMOTE_REF_COLOR
    })
    const incomingLaneIndex = viewModels[2]!.inputSwimlanes.findIndex(
      (node) => node.id === GIT_HISTORY_INCOMING_CHANGES_ID
    )
    expect(viewModels[2]!.outputSwimlanes[incomingLaneIndex]?.color).toBe(
      GIT_HISTORY_REMOTE_REF_COLOR
    )
  })

  it('assigns stable colors to current, remote, and base refs', () => {
    const currentRef = branch('feature', 'A')
    const remoteRef = remote('origin/feature', 'R')
    const baseRef = remote('origin/main', 'B')

    const colorMap = buildDefaultGitHistoryColorMap({ currentRef, remoteRef, baseRef })

    expect(colorMap.get(currentRef.id)).toBe(GIT_HISTORY_REF_COLOR)
    expect(colorMap.get(remoteRef.id)).toBe(GIT_HISTORY_REMOTE_REF_COLOR)
    expect(colorMap.get(baseRef.id)).toBe(GIT_HISTORY_BASE_REF_COLOR)
  })
})
