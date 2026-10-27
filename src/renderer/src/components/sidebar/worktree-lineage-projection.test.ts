import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo,
  getWorktreeLineageProjection,
  getWorktreeLineageIdentity
} from '../../../../shared/sidebar-list/worktree-lineage-projection'

function makeWorktree(id: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    instanceId: `${id}-instance`,
    path: `/tmp/${id}`,
    branch: id,
    isMainWorktree: false
  } as unknown as Worktree
}

function makeLineage(childId: string, parentId: string): WorktreeLineage {
  return {
    worktreeId: childId,
    worktreeInstanceId: `${childId}-instance`,
    parentWorktreeId: parentId,
    parentWorktreeInstanceId: `${parentId}-instance`
  } as unknown as WorktreeLineage
}

/** Model the many-child lineage shape scanned on each store write. */
function buildFixture(childCount: number): {
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
} {
  const worktreeMap = new Map<string, Worktree>()
  const lineageById: Record<string, WorktreeLineage> = {}
  worktreeMap.set('root', makeWorktree('root'))
  for (let index = 0; index < childCount; index += 1) {
    const id = `child-${index}`
    worktreeMap.set(id, makeWorktree(id))
    lineageById[id] = makeLineage(id, 'root')
  }
  return { lineageById, worktreeMap }
}

function requiredRow(rows: ReadonlyMap<string, Worktree>, id: string): Worktree {
  const row = rows.get(id)
  if (!row) {
    throw new Error(`Missing fixture ${id}`)
  }
  return row
}

describe('worktree lineage projection cache', () => {
  it('reuses the cyclic-id scan for an unchanged input pair', () => {
    const { lineageById, worktreeMap } = buildFixture(8)
    const first = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
    const second = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
    expect(second).toBe(first)
  })

  it('reuses the children projection for an unchanged input pair', () => {
    const { lineageById, worktreeMap } = buildFixture(8)
    const first = getWorktreeLineageProjection(lineageById, worktreeMap).children
    const second = getWorktreeLineageProjection(lineageById, worktreeMap).children
    expect(second).toBe(first)
    expect(first.get(requiredRow(worktreeMap, 'root'))?.map((worktree) => worktree.id)).toEqual([
      'child-0',
      'child-1',
      'child-2',
      'child-3',
      'child-4',
      'child-5',
      'child-6',
      'child-7'
    ])
  })

  it('rescans when either input is replaced', () => {
    const { lineageById, worktreeMap } = buildFixture(4)
    const baseline = getWorktreeLineageProjection(lineageById, worktreeMap).children

    const replacedLineage = { ...lineageById }
    expect(getWorktreeLineageProjection(replacedLineage, worktreeMap).children).not.toBe(baseline)

    const replacedWorktrees = new Map(worktreeMap)
    expect(getWorktreeLineageProjection(lineageById, replacedWorktrees).children).not.toBe(baseline)
  })

  it('reflects a removed lineage edge as soon as the record is replaced', () => {
    const { lineageById, worktreeMap } = buildFixture(2)
    expect(
      getWorktreeLineageProjection(lineageById, worktreeMap).children.get(
        requiredRow(worktreeMap, 'root')
      )
    ).toHaveLength(2)

    const withoutFirstChild = { ...lineageById }
    delete withoutFirstChild['child-0']
    const reprojected = getWorktreeLineageProjection(withoutFirstChild, worktreeMap).children
    expect(
      reprojected.get(requiredRow(worktreeMap, 'root'))?.map((worktree) => worktree.id)
    ).toEqual(['child-1'])
    expect(
      getLineageRenderInfo(requiredRow(worktreeMap, 'child-0'), withoutFirstChild, worktreeMap)
        .state
    ).toBe('none')
  })

  it('still reports cycles from the cached scan', () => {
    const worktreeMap = new Map<string, Worktree>([
      ['a', makeWorktree('a')],
      ['b', makeWorktree('b')]
    ])
    const lineageById: Record<string, WorktreeLineage> = {
      a: makeLineage('a', 'b'),
      b: makeLineage('b', 'a')
    }
    const cyclic = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
    expect([...cyclic].sort()).toEqual(
      [...worktreeMap.values()].map(getWorktreeLineageIdentity).sort()
    )
    expect(getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)).toBe(cyclic)
    expect(getWorktreeLineageProjection(lineageById, worktreeMap).children.size).toBe(0)
  })
})
