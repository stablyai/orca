import { describe, expect, it, vi } from 'vitest'
import type * as ResolvedWorktreeLineage from '../../../../shared/resolved-worktree-lineage'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

const counters = vi.hoisted(() => ({ cycleDetections: 0 }))

vi.mock('../../../../shared/resolved-worktree-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof ResolvedWorktreeLineage>()
  return {
    ...actual,
    getCyclicWorktreeLineageChildIds: (
      ...args: Parameters<typeof actual.getCyclicWorktreeLineageChildIds>
    ) => {
      counters.cycleDetections += 1
      return actual.getCyclicWorktreeLineageChildIds(...args)
    }
  }
})

import { computeVisibleWorktreeIds } from './visible-worktrees'
import type { computeVisibleWorktrees } from './visible-worktrees'
import { getCyclicProjectedWorktreeLineageIds } from './worktree-lineage-projection'
import { getLineageAncestorIndex, getSortedWorktreeRankIndex } from './visible-worktree-indexes'

type IdentifiedWorktree = Worktree & { instanceId: string }

function makeWorktree(id: string, repoId = 'repo1'): IdentifiedWorktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId,
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeLineage(child: IdentifiedWorktree, parent: IdentifiedWorktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId,
    origin: 'cli',
    capture: { source: 'terminal-context', confidence: 'inferred' },
    createdAt: 1
  }
}

function makeTab(id: string, worktreeId: string, ptyId: string): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const repoMap = new Map<string, Repo>([
  ['repo1', { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }]
])

function visibleOptions(
  overrides: Partial<Parameters<typeof computeVisibleWorktrees>[2]> = {}
): Parameters<typeof computeVisibleWorktrees>[2] {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: null,
    ptyIdsByTabId: null,
    browserTabsByWorktree: null,
    worktreeIdsWithLiveAgent: new Set<string>(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map<string, string>(),
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    worktreeLineageById: {},
    ...overrides
  }
}

describe('visible worktree indexes', () => {
  it('reuses the lineage projection instead of rebuilding it on every store write', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const worktreesByRepo = { repo1: [parent, child] }
    const sortedIds = [parent.id, child.id]
    const worktreeLineageById = { [child.id]: makeLineage(child, parent) }

    counters.cycleDetections = 0
    // Each call stands for one store write that re-fires the sidebar memo
    // (PTY spawn/exit, tab open/close, agent status transition) without
    // changing `worktreesByRepo`.
    for (let write = 0; write < 10; write += 1) {
      computeVisibleWorktreeIds(worktreesByRepo, sortedIds, visibleOptions({ worktreeLineageById }))
    }

    expect(counters.cycleDetections).toBe(1)
  })

  it('returns identity-stable index maps for unchanged store inputs', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const worktreesByRepo = { repo1: [parent, child] }
    const sortedIds = [parent.id, child.id]
    const lineageById = { [child.id]: makeLineage(child, parent) }

    const firstAncestors = getLineageAncestorIndex(worktreesByRepo)
    const secondAncestors = getLineageAncestorIndex(worktreesByRepo)
    expect(secondAncestors).toBe(firstAncestors)
    expect(getSortedWorktreeRankIndex(sortedIds)).toBe(getSortedWorktreeRankIndex(sortedIds))
    expect([...getSortedWorktreeRankIndex(sortedIds)]).toEqual([
      [parent.id, 0],
      [child.id, 1]
    ])

    expect(getCyclicProjectedWorktreeLineageIds(lineageById, secondAncestors)).toBe(
      getCyclicProjectedWorktreeLineageIds(lineageById, firstAncestors)
    )
  })

  it('keeps archived parents out of the cached ancestor index', () => {
    const parent = makeWorktree('parent')
    parent.isArchived = true
    const child = makeWorktree('child')
    const worktreesByRepo = { repo1: [parent, child] }
    const sortedIds = [child.id, parent.id]
    const worktreeLineageById = { [child.id]: makeLineage(child, parent) }
    const opts = visibleOptions({
      showSleepingWorkspaces: false,
      tabsByWorktree: { [child.id]: [makeTab('t-child', child.id, 'p-child')] },
      ptyIdsByTabId: { 't-child': ['p-child'] },
      worktreeLineageById
    })

    // Twice: the second call reads the warm cache, which is where an index
    // built from the store's own (archive-inclusive) worktree map would leak a
    // phantom ancestor row.
    expect(computeVisibleWorktreeIds(worktreesByRepo, sortedIds, opts)).toEqual([child.id])
    expect(computeVisibleWorktreeIds(worktreesByRepo, sortedIds, opts)).toEqual([child.id])
    expect(getLineageAncestorIndex(worktreesByRepo).has(parent.id)).toBe(false)
  })

  it('keeps the last row for a two-host id collision, as the per-call map did', () => {
    const local: Worktree = {
      ...makeWorktree('shared'),
      hostId: LOCAL_EXECUTION_HOST_ID,
      path: '/tmp/local'
    }
    const remote: Worktree = { ...makeWorktree('shared'), hostId: 'ssh:box', path: '/tmp/remote' }
    const worktreesByRepo = { repo1: [local, remote] }

    expect(getLineageAncestorIndex(worktreesByRepo).get('shared')?.path).toBe('/tmp/remote')
  })
})
