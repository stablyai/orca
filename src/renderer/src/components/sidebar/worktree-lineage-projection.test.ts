import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo,
  getProjectedWorktreeLineageChildrenByParentId
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

describe('worktree lineage projection cache', () => {
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
