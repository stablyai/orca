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
