import { computeVisibleWorktrees } from './compute-visible-worktrees'
import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getPinnedSectionWorktrees,
  isPinnedSectionWorktree
} from '../../../../shared/sidebar-list/pinned-section-worktrees'
import { worktree, repoMap } from './worktree-list-groups-test-fixtures'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    ...worktree,
    id,
    instanceId: `${id}-instance`,
    displayName: id,
    ...overrides
  }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'terminal-context', confidence: 'inferred' },
    createdAt: 1
  }
}

function visibleRows(
  rows: Worktree[],
  lineageById: Record<string, WorktreeLineage>,
  map: Map<string, Worktree>,
  filterRepoIds: string[] = []
) {
  return computeVisibleWorktrees(
    { repo: [...map.values()] },
    rows.map((row) => row.id),
    {
      filterRepoIds,
      showSleepingWorkspaces: true,
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      worktreeIdsWithLiveAgent: new Set(),
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      pairedDeviceIdsByEnvironment: new Map(),
      repoMap,
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      worktreeLineageById: lineageById
    }
  )
}

describe('getPinnedSectionWorktrees', () => {
  const parent = makeWorktree('parent')
  const child = makeWorktree('child')
  const grandchild = makeWorktree('grandchild')
  const sibling = makeWorktree('sibling')
  const lineageById = {
    [child.id]: makeLineage(child, parent),
    [grandchild.id]: makeLineage(grandchild, child)
  }
  const worktreeMap = new Map([
    [parent.id, parent],
    [child.id, child],
    [grandchild.id, grandchild],
    [sibling.id, sibling]
  ])

  it('includes only explicitly pinned rows when there is no lineage', () => {
    const pinned = makeWorktree('pinned', { isPinned: true })
    const loose = makeWorktree('loose')

    expect(getPinnedSectionWorktrees([pinned, loose], {}, new Map([[pinned.id, pinned]]))).toEqual([
      pinned
    ])
  })

  it('does not include an unpinned row with the same id on another host', () => {
    const pinnedLocal = makeWorktree('shared', { hostId: 'local', isPinned: true })
    const unpinnedSsh = makeWorktree('shared', {
      hostId: 'ssh:box',
      instanceId: 'shared-ssh-instance'
    })

    expect(
      getPinnedSectionWorktrees(
        [pinnedLocal, unpinnedSsh],
        {},
        new Map([[pinnedLocal.id, pinnedLocal]])
      ).map((candidate) => candidate.hostId)
    ).toEqual(['local'])
  })

  it('includes visible descendants of a pinned parent', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedParent.id, pinnedParent)

    expect(
      getPinnedSectionWorktrees([pinnedParent, child, grandchild, sibling], lineageById, map).map(
        (worktree) => worktree.id
      )
    ).toEqual([pinnedParent.id, child.id, grandchild.id])
  })

  it("does not pull a pinned child's unpinned parent into Pinned", () => {
    const pinnedChild = { ...child, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedChild.id, pinnedChild)

    expect(
      getPinnedSectionWorktrees([parent, pinnedChild], lineageById, map).map(
        (worktree) => worktree.id
      )
    ).toEqual([pinnedChild.id])
  })

  it('restores the middle parent before deriving pinned descendant placement', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedParent.id, pinnedParent)

    expect(
      getPinnedSectionWorktrees(
        visibleRows([pinnedParent, grandchild], lineageById, map),
        lineageById,
        map
      ).map((worktree) => worktree.id)
    ).toEqual([pinnedParent.id, child.id, grandchild.id])
  })

  it('breaks inherited pin placement at an explicitly hidden intermediate project', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const hidden = { ...child, repoId: 'hidden-project' }
    const visible = { ...grandchild, repoId: 'visible-project' }
    const map = new Map([pinnedParent, hidden, visible].map((row) => [row.id, row]))
    const allowed = [pinnedParent.repoId, visible.repoId]
    expect(
      getPinnedSectionWorktrees(
        visibleRows([pinnedParent, visible], lineageById, map, allowed),
        lineageById,
        map,
        allowed
      )
    ).toEqual([pinnedParent])
    expect(
      getPinnedSectionWorktrees(
        visibleRows([pinnedParent, visible], lineageById, map),
        lineageById,
        map
      )
    ).toEqual([pinnedParent, hidden, visible])
    const rows = buildRows(
      'repo',
      [pinnedParent, visible],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      lineageById,
      map,
      true,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [],
      undefined,
      'local',
      'single-location',
      allowed
    )
    expect(rows.find((row) => row.type === 'item' && row.worktree.id === visible.id)).toMatchObject(
      { sectionKey: 'repo:visible-project', depth: 0 }
    )
  })

  it('does not collect descendants of a pinned parent that is not itself visible', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedParent.id, pinnedParent)

    expect(
      getPinnedSectionWorktrees([child, sibling], lineageById, map).map((worktree) => worktree.id)
    ).toEqual([])
  })

  it('handles a deep pinned lineage without overflowing the renderer stack', () => {
    const depth = 6_000
    const worktrees: Worktree[] = []
    const lineageById: Record<string, WorktreeLineage> = {}
    for (let index = 0; index < depth; index++) {
      const current = makeWorktree(`deep-${index}`, { isPinned: index === 0 })
      worktrees.push(current)
      const parent = worktrees[index - 1]
      if (parent) {
        lineageById[current.id] = makeLineage(current, parent)
      }
    }

    expect(
      getPinnedSectionWorktrees(
        worktrees,
        lineageById,
        new Map(worktrees.map((worktree) => [worktree.id, worktree]))
      )
    ).toHaveLength(depth)
  })

  it('builds rows for a deep expanded pinned lineage without overflowing the renderer stack', () => {
    const depth = 6_000
    const worktrees: Worktree[] = []
    const lineageById: Record<string, WorktreeLineage> = {}
    for (let index = 0; index < depth; index++) {
      const current = makeWorktree(`rendered-deep-${index}`, { isPinned: true })
      worktrees.push(current)
      const parent = worktrees[index - 1]
      if (parent) {
        lineageById[current.id] = makeLineage(current, parent)
      }
    }

    const rows = buildRows(
      'none',
      worktrees,
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      lineageById,
      new Map(worktrees.map((worktree) => [worktree.id, worktree])),
      true
    )

    expect(rows.filter((row) => row.type === 'item')).toHaveLength(depth)
  })
})

describe('isPinnedSectionWorktree', () => {
  const parent = makeWorktree('parent', { isPinned: true })
  const child = makeWorktree('child')
  const lineageById = { [child.id]: makeLineage(child, parent) }
  const worktreeMap = new Map([
    [parent.id, parent],
    [child.id, child]
  ])

  it('treats an unpinned child of a visible pinned parent as pinned-section membership', () => {
    expect(isPinnedSectionWorktree(child, [parent, child], lineageById, worktreeMap)).toBe(true)
  })

  it('does not treat an unrelated unpinned workspace as pinned-section membership', () => {
    const other = makeWorktree('other')
    expect(isPinnedSectionWorktree(other, [parent, child, other], lineageById, worktreeMap)).toBe(
      false
    )
  })
})
