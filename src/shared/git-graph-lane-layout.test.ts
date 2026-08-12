import { describe, expect, it } from 'vitest'
import type { GitHistoryItem, GitHistoryItemRef } from './git-history-types'
import { GIT_HISTORY_LANE_COLORS, GIT_HISTORY_REF_COLOR } from './git-history-types'
import { buildGitGraphColorMap, buildGitGraphRows } from './git-graph-lane-layout'
import { getGitHistoryItemLaneIndex, getGitHistoryMergeParentLaneIndex } from './git-history-graph'

function item(
  id: string,
  parentIds: string[],
  references: GitHistoryItemRef[] = []
): GitHistoryItem {
  return { id, parentIds, subject: id, message: id, displayId: id, references }
}

function branch(name: string, revision: string): GitHistoryItemRef {
  return { id: `refs/heads/${name}`, name, revision, category: 'branches' }
}

function remote(name: string, revision: string): GitHistoryItemRef {
  return { id: `refs/remotes/${name}`, name, revision, category: 'remote branches' }
}

function tag(name: string, revision: string): GitHistoryItemRef {
  return { id: `refs/tags/${name}`, name, revision, category: 'tags' }
}

const [LANE_1, LANE_2] = GIT_HISTORY_LANE_COLORS

describe('buildGitGraphColorMap', () => {
  it('keeps the HEAD accent for the current branch and cycles lanes for the rest', () => {
    const currentRef = branch('main', 'A')
    const colorMap = buildGitGraphColorMap(
      [
        item('A', ['C'], [currentRef]),
        item('B', ['C'], [branch('feature', 'B')]),
        item('C', [], [branch('release', 'C')])
      ],
      currentRef
    )

    expect(colorMap.get('refs/heads/main')).toBe(GIT_HISTORY_REF_COLOR)
    expect(colorMap.get('refs/heads/feature')).toBe(LANE_1)
    expect(colorMap.get('refs/heads/release')).toBe(LANE_2)
  })

  it('is stable: identical input produces identical assignments', () => {
    const items = [item('A', ['B'], [branch('one', 'A')]), item('B', [], [branch('two', 'B')])]
    expect(buildGitGraphColorMap(items)).toEqual(buildGitGraphColorMap(items))
  })

  it('shares one color between a local branch and its remote-tracking ref', () => {
    const colorMap = buildGitGraphColorMap([
      item('A', ['B'], [branch('feature', 'A')]),
      item('B', ['C'], [remote('origin/feature', 'B')]),
      item('C', [], [remote('upstream/feature', 'C')])
    ])

    expect(colorMap.get('refs/heads/feature')).toBe(LANE_1)
    expect(colorMap.get('refs/remotes/origin/feature')).toBe(LANE_1)
    expect(colorMap.get('refs/remotes/upstream/feature')).toBe(LANE_1)
  })

  it('extends the shared color to remote-tracking refs of the current branch', () => {
    const currentRef = branch('main', 'A')
    const colorMap = buildGitGraphColorMap(
      [item('A', ['B'], [currentRef]), item('B', [], [remote('origin/main', 'B')])],
      currentRef
    )

    expect(colorMap.get('refs/remotes/origin/main')).toBe(GIT_HISTORY_REF_COLOR)
  })

  it('gives a remote-only branch its own lane color', () => {
    const colorMap = buildGitGraphColorMap([
      item('A', ['B'], [branch('main', 'A')]),
      item('B', [], [remote('origin/experiment', 'B')])
    ])

    expect(colorMap.get('refs/remotes/origin/experiment')).toBe(LANE_2)
  })

  it('shares one color across slashed branch names and their remote refs', () => {
    const colorMap = buildGitGraphColorMap([
      item('A', ['C'], [branch('feat/orca-cli', 'A')]),
      item('B', ['C'], [remote('origin/feat/orca-cli', 'B')]),
      item('C', [], [])
    ])

    expect(colorMap.get('refs/heads/feat/orca-cli')).toBe(LANE_1)
    expect(colorMap.get('refs/remotes/origin/feat/orca-cli')).toBe(LANE_1)
  })

  it('maps tags to explicit undefined so pills inherit the lane color', () => {
    const colorMap = buildGitGraphColorMap([item('A', [], [tag('v1.0.0', 'A')])])

    expect(colorMap.has('refs/tags/v1.0.0')).toBe(true)
    expect(colorMap.get('refs/tags/v1.0.0')).toBeUndefined()
  })

  it('does not let tags consume lane palette slots', () => {
    const colorMap = buildGitGraphColorMap([
      item('A', ['B'], [tag('v2.0.0', 'A')]),
      item('B', [], [branch('feature', 'B')])
    ])

    expect(colorMap.get('refs/heads/feature')).toBe(LANE_1)
  })

  it('wraps around the palette when branches outnumber lane colors', () => {
    const items = Array.from({ length: GIT_HISTORY_LANE_COLORS.length + 1 }, (_, index) =>
      item(`C${index}`, [], [branch(`branch-${index}`, `C${index}`)])
    )
    const colorMap = buildGitGraphColorMap(items)

    expect(colorMap.get('refs/heads/branch-0')).toBe(LANE_1)
    expect(colorMap.get(`refs/heads/branch-${GIT_HISTORY_LANE_COLORS.length}`)).toBe(LANE_1)
  })
})

describe('buildGitGraphRows', () => {
  it('lays out two unmerged parallel branches on separate lanes', () => {
    const currentRef = branch('main', 'A')
    const rows = buildGitGraphRows(
      [item('A', ['C'], [currentRef]), item('B', ['C'], [branch('feature', 'B')]), item('C', [])],
      currentRef
    )

    expect(rows.map((row) => row.kind)).toEqual(['HEAD', 'node', 'node'])
    expect(rows[0]!.outputSwimlanes).toEqual([{ id: 'C', color: GIT_HISTORY_REF_COLOR }])
    // The feature tip was not in any input lane, so it opens a lane to the right.
    expect(getGitHistoryItemLaneIndex(rows[1]!)).toBe(1)
    expect(rows[1]!.outputSwimlanes).toEqual([
      { id: 'C', color: GIT_HISTORY_REF_COLOR },
      { id: 'C', color: LANE_1 }
    ])
    // Both lanes converge on the shared root and close there.
    expect(getGitHistoryItemLaneIndex(rows[2]!)).toBe(0)
    expect(rows[2]!.outputSwimlanes).toEqual([])
  })

  it('routes a merge commit to both parents and keeps branch colors', () => {
    const currentRef = branch('main', 'M')
    const rows = buildGitGraphRows(
      [
        item('M', ['A', 'B'], [currentRef]),
        item('A', ['C']),
        item('B', ['C'], [branch('feature', 'B')]),
        item('C', [])
      ],
      currentRef
    )

    expect(rows[0]!.outputSwimlanes).toEqual([
      { id: 'A', color: GIT_HISTORY_REF_COLOR },
      { id: 'B', color: LANE_1 }
    ])
    expect(getGitHistoryMergeParentLaneIndex(rows[0]!, 'B')).toBe(1)
    // The merged-in branch keeps its color down its own lane.
    expect(getGitHistoryItemLaneIndex(rows[2]!)).toBe(1)
    expect(rows[2]!.outputSwimlanes[1]).toEqual({ id: 'C', color: LANE_1 })
  })

  it('opens one extra lane per parent of an octopus merge', () => {
    const currentRef = branch('main', 'M')
    const rows = buildGitGraphRows(
      [
        item('M', ['A', 'B', 'C'], [currentRef]),
        item('A', ['R']),
        item('B', ['R'], [branch('two', 'B')]),
        item('C', ['R'], [branch('three', 'C')]),
        item('R', [])
      ],
      currentRef
    )

    expect(rows[0]!.outputSwimlanes).toEqual([
      { id: 'A', color: GIT_HISTORY_REF_COLOR },
      { id: 'B', color: LANE_1 },
      { id: 'C', color: LANE_2 }
    ])
    expect(getGitHistoryMergeParentLaneIndex(rows[0]!, 'B')).toBe(1)
    expect(getGitHistoryMergeParentLaneIndex(rows[0]!, 'C')).toBe(2)
    // All three lanes collapse into the shared root.
    expect(rows[4]!.inputSwimlanes).toHaveLength(3)
    expect(rows[4]!.outputSwimlanes).toEqual([])
  })

  it('keeps disconnected orphan histories on independent lanes', () => {
    const rows = buildGitGraphRows([
      item('A', ['R1'], [branch('main', 'A')]),
      item('R1', []),
      item('B', ['R2'], [branch('orphan', 'B')]),
      item('R2', [])
    ])

    // First root closes its lane before the orphan tip appears.
    expect(rows[1]!.outputSwimlanes).toEqual([])
    // The orphan tip starts from an empty board on lane 0 with its own color.
    expect(rows[2]!.inputSwimlanes).toEqual([])
    expect(getGitHistoryItemLaneIndex(rows[2]!)).toBe(0)
    expect(rows[2]!.outputSwimlanes).toEqual([{ id: 'R2', color: LANE_2 }])
  })

  it('keeps interleaved orphan histories on parallel lanes without crossing', () => {
    const rows = buildGitGraphRows([
      item('A', ['R1'], [branch('main', 'A')]),
      item('B', ['R2'], [branch('orphan', 'B')]),
      item('R1', []),
      item('R2', [])
    ])

    expect(getGitHistoryItemLaneIndex(rows[0]!)).toBe(0)
    expect(getGitHistoryItemLaneIndex(rows[1]!)).toBe(1)
    expect(rows[1]!.outputSwimlanes).toEqual([
      { id: 'R1', color: LANE_1 },
      { id: 'R2', color: LANE_2 }
    ])
    // R1 closes lane 0; R2's lane shifts left and closes last.
    expect(rows[2]!.outputSwimlanes).toEqual([{ id: 'R2', color: LANE_2 }])
    expect(rows[3]!.outputSwimlanes).toEqual([])
  })

  it('leaves lanes open for parents truncated past the load limit', () => {
    const rows = buildGitGraphRows([
      item('A', ['Z'], [branch('main', 'A')]),
      item('B', ['Z'], [branch('feature', 'B')])
    ])

    // Z was cut off by the limit: both lanes still point at it after the last row.
    expect(rows[1]!.outputSwimlanes).toEqual([
      { id: 'Z', color: LANE_1 },
      { id: 'Z', color: LANE_2 }
    ])
  })

  it('marks the current branch tip as HEAD and detached heads as plain nodes', () => {
    const currentRef = branch('main', 'A')
    const attached = buildGitGraphRows([item('A', [], [currentRef])], currentRef)
    expect(attached[0]!.kind).toBe('HEAD')

    const detachedRef: GitHistoryItemRef = {
      id: 'A',
      name: 'A',
      revision: 'A',
      category: 'commits'
    }
    const detached = buildGitGraphRows([item('A', [], [])], detachedRef)
    expect(detached[0]!.kind).toBe('HEAD')
  })

  it('colors tag pills with the lane color of their commit', () => {
    const currentRef = branch('main', 'A')
    const rows = buildGitGraphRows(
      [item('A', ['B'], [currentRef]), item('B', [], [tag('v1.0.0', 'B')])],
      currentRef
    )

    const tagRef = rows[1]!.historyItem.references?.find((ref) => ref.id === 'refs/tags/v1.0.0')
    expect(tagRef?.color).toBe(GIT_HISTORY_REF_COLOR)
  })

  it('never inserts boundary rows into the all-refs graph', () => {
    const currentRef = branch('main', 'A')
    const rows = buildGitGraphRows(
      [item('A', ['B'], [currentRef]), item('B', [], [remote('origin/main', 'B')])],
      currentRef
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.kind === 'HEAD' || row.kind === 'node')).toBe(true)
  })
})
