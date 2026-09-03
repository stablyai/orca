import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo,
  getProjectedWorktreeLineageChildrenByParentId
} from './worktree-lineage-projection'

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

/**
 * A sidebar-scale fixture: one root with many children, mirroring the shape the
 * row builder scans on every store write.
 */
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

describe('worktree lineage projection cache', () => {
  it('reuses the cyclic-id scan for an unchanged input pair', () => {
    const { lineageById, worktreeMap } = buildFixture(8)
    const first = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
    const second = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
    expect(second).toBe(first)
  })

  it('reuses the children projection for an unchanged input pair', () => {
    const { lineageById, worktreeMap } = buildFixture(8)
    const first = getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap)
    const second = getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap)
    expect(second).toBe(first)
    expect(first.get('root')?.map((worktree) => worktree.id)).toEqual([
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
    const baseline = getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap)

    const replacedLineage = { ...lineageById }
    expect(getProjectedWorktreeLineageChildrenByParentId(replacedLineage, worktreeMap)).not.toBe(
      baseline
    )

    const replacedWorktrees = new Map(worktreeMap)
    expect(getProjectedWorktreeLineageChildrenByParentId(lineageById, replacedWorktrees)).not.toBe(
      baseline
    )
  })

  it('reflects a removed lineage edge as soon as the record is replaced', () => {
    const { lineageById, worktreeMap } = buildFixture(2)
    expect(
      getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap).get('root')
    ).toHaveLength(2)

    const withoutFirstChild = { ...lineageById }
    delete withoutFirstChild['child-0']
    const reprojected = getProjectedWorktreeLineageChildrenByParentId(
      withoutFirstChild,
      worktreeMap
    )
    expect(reprojected.get('root')?.map((worktree) => worktree.id)).toEqual(['child-1'])
    expect(
      getLineageRenderInfo(
        worktreeMap.get('child-0') as Worktree,
        withoutFirstChild,
        worktreeMap,
        getCyclicProjectedWorktreeLineageIds(withoutFirstChild, worktreeMap)
      ).state
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
    expect([...cyclic].sort()).toEqual(['a', 'b'])
    expect(getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)).toBe(cyclic)
    expect(getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap).size).toBe(0)
  })
})
