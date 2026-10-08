import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildRows } from './worktree-list/grouping/build-rows'
import { worktree, repoMap } from './worktree-list-groups-test-fixtures'
import {
  getCyclicProjectedWorktreeLineageIds,
  getSidebarLineageAncestors
} from './worktree-lineage-projection'

function pair(parentHost: ExecutionHostId | undefined, childHost: ExecutionHostId | undefined) {
  const parent: Worktree = { ...worktree, id: 'parent', instanceId: 'p', hostId: parentHost }
  const child: Worktree = { ...worktree, id: 'child', instanceId: 'c', hostId: childHost }
  const lineageById: Record<string, WorktreeLineage> = {
    child: {
      worktreeId: 'child',
      worktreeInstanceId: 'c',
      parentWorktreeId: 'parent',
      parentWorktreeInstanceId: 'p',
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
      createdAt: 1
    }
  }
  return { parent, child, lineageById }
}

describe('getSidebarLineageAncestors', () => {
  // Why: only a parent on the child's own host nests it; a missing host id matches only another.
  it.each([
    ['both without a host id', undefined, undefined, true],
    ['both local', 'local', 'local', true],
    ['parent without a host id, child local', undefined, 'local', false],
    ['parent local, child without a host id', 'local', undefined, false]
  ] as const)('%s: nests exactly when the sidebar rows do', (_, parentHost, childHost, nests) => {
    const { parent, child, lineageById } = pair(parentHost, childHost)
    const worktreeMap = new Map([
      [parent.id, parent],
      [child.id, child]
    ])
    const sidebarDepth = buildRows(
      'none',
      [parent, child],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      lineageById,
      worktreeMap,
      true
    ).find((row) => row.type === 'item' && row.worktree.id === 'child')
    const rows = new Map([parent, child].map((entry) => [getWorktreeHostIdentity(entry), entry]))
    const ancestors = getSidebarLineageAncestors(
      child,
      lineageById,
      rows,
      getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
    )

    expect(sidebarDepth?.type === 'item' && sidebarDepth.depth).toBe(nests ? 1 : 0)
    expect(ancestors.map((entry) => entry.id)).toEqual(nests ? ['parent'] : [])
  })
})
