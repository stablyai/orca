import { describe, expect, it } from 'vitest'
import type { GitHistoryItem, GitHistoryItemRef } from './git-history-types'
import { GIT_HISTORY_REMOTE_REF_COLOR } from './git-history-types'
import {
  GIT_HISTORY_INCOMING_CHANGES_ID,
  GIT_HISTORY_OUTGOING_CHANGES_ID
} from './git-history-boundary-rows'
import { buildDefaultGitHistoryColorMap, buildGitHistoryViewModels } from './git-history-graph'

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
  it.each([
    ['A', 'V'],
    ['V', 'A']
  ])('keeps other lanes when parents are %s then %s', (...parents) => {
    const rootRef = branch('unrelated', 'V')
    const viewModels = buildGitHistoryViewModels(
      [item('M', parents), item('V', [], [rootRef]), item('A', ['B']), item('B', [])],
      new Map([[rootRef.id, undefined]])
    )
    const root = viewModels[1]!
    const rootLane = root.inputSwimlanes.find((lane) => lane.id === 'V')!

    expect(root.inputSwimlanes.map((lane) => lane.id)).toEqual(parents)
    expect(root.outputSwimlanes.map((lane) => lane.id)).toEqual(['A'])
    expect(root.historyItem.references?.[0]?.color).toBe(rootLane.color)
    expect(viewModels[2]!.inputSwimlanes.map((lane) => lane.id)).toEqual(['A'])
    expect(viewModels[2]!.outputSwimlanes.map((lane) => lane.id)).toEqual(['B'])
    expect(viewModels[3]!.outputSwimlanes).toEqual([])
  })

  it('ends every converging root lane while retaining another history', () => {
    const rootRef = branch('root', 'V')
    const rows = buildGitHistoryViewModels(
      [item('M', ['A', 'C', 'V']), item('A', ['V']), item('V', [], [rootRef]), item('C', [])],
      new Map([[rootRef.id, undefined]])
    )
    const root = rows[2]!
    const survivingLane = root.inputSwimlanes[1]!

    expect(root.inputSwimlanes.map((lane) => lane.id)).toEqual(['V', 'C', 'V'])
    expect(root.outputSwimlanes).toEqual([survivingLane])
    expect(root.historyItem.references?.[0]?.color).toBe(root.inputSwimlanes[0]!.color)
    expect(rows[3]!.inputSwimlanes).toEqual([survivingLane])
    expect(rows[3]!.outputSwimlanes).toEqual([])
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
})
