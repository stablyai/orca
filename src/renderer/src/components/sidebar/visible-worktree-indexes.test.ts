import { useAppStore } from '@/store'
import { describe, expect, it, vi } from 'vitest'
import type * as ResolvedWorktreeLineage from '../../../../shared/resolved-worktree-lineage'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

const counters = vi.hoisted(() => ({ cycleDetections: 0 }))

vi.mock('../../../../shared/resolved-worktree-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof ResolvedWorktreeLineage>()
  return {
    ...actual,
    resolveWorktreeLineageParents: (
      ...args: Parameters<typeof actual.resolveWorktreeLineageParents>
    ) => {
      counters.cycleDetections += 1
      return actual.resolveWorktreeLineageParents(...args)
    }
  }
})

import { computeVisibleWorktreeIds } from './compute-visible-worktrees'
import type { computeVisibleWorktrees } from './compute-visible-worktrees'
import {
  findWorktreeLineageRow,
  getSidebarLineageAncestors,
  getSidebarLineageParentsByIdentity
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import {
  requireKnownLineageRow,
  requireCurrentLineageRow,
  getLineageInputs,
  getLineageAncestorIndex,
  getSortedWorktreeRankIndex
} from './visible-worktree-indexes'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

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
  it('keeps subscriber snapshots stable until rows, folders or either saved edge map changes', () => {
    const firstParent = makeWorktree('first-parent')
    const secondParent = makeWorktree('second-parent')
    const child = makeWorktree('child')
    const folder = makeFolderWorkspace()
    const folderKey = folderWorkspaceKey(folder.id)
    const workspaceEdge: WorkspaceLineage = {
      childWorkspaceKey: worktreeWorkspaceKey(child.id),
      childInstanceId: child.instanceId,
      parentWorkspaceKey: folderKey,
      parentInstanceId: folderKey,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    let state: Parameters<typeof getLineageInputs>[0] = {
      worktreesByRepo: { repo1: [firstParent, secondParent, child] },
      folderWorkspaces: [folder],
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    }
    let snapshot = getLineageInputs(state)
    expect(getLineageInputs({ ...state })).toBe(snapshot)
    const emptyState = {
      worktreesByRepo: {},
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    }
    expect(getLineageInputs(emptyState)).toBe(getLineageInputs({ ...emptyState }))
    const legacyState = { worktreesByRepo: state.worktreesByRepo }
    expect(getLineageInputs(legacyState)).toBe(getLineageInputs({ ...legacyState }))

    const updates: [Partial<typeof state>, string[]][] = [
      [{ worktreeLineageById: { [child.id]: makeLineage(child, firstParent) } }, [firstParent.id]],
      [
        { worktreeLineageById: { [child.id]: makeLineage(child, secondParent) } },
        [secondParent.id]
      ],
      [{ worktreeLineageById: {} }, []],
      [
        { workspaceLineageByChildKey: { [workspaceEdge.childWorkspaceKey]: workspaceEdge } },
        [folderKey]
      ],
      [
        {
          workspaceLineageByChildKey: {
            [workspaceEdge.childWorkspaceKey]: {
              ...workspaceEdge,
              parentWorkspaceKey: worktreeWorkspaceKey(secondParent.id),
              parentInstanceId: secondParent.instanceId
            }
          }
        },
        [secondParent.id]
      ],
      [{ workspaceLineageByChildKey: {} }, []],
      [
        { worktreeLineageById: { [child.id]: makeLineage(child, secondParent) } },
        [secondParent.id]
      ],
      [
        {
          worktreesByRepo: {
            repo1: [firstParent, { ...secondParent, instanceId: 'replacement' }, child]
          }
        },
        []
      ],
      [{ worktreesByRepo: { repo1: [firstParent, secondParent, child] } }, [secondParent.id]],
      [
        {
          worktreeLineageById: {},
          workspaceLineageByChildKey: { [workspaceEdge.childWorkspaceKey]: workspaceEdge }
        },
        [folderKey]
      ],
      [{ folderWorkspaces: [] }, []],
      [{ folderWorkspaces: [{ ...folder, name: 'Renamed folder' }] }, [folderKey]]
    ]
    for (const [patch, ancestors] of updates) {
      state = { ...state, ...patch }
      const next = getLineageInputs(state)
      expect(next).not.toBe(snapshot)
      expect(getLineageInputs({ ...state })).toBe(next)
      expect(
        getSidebarLineageAncestors(child, next.lineageById, next.worktreeMap).map((row) => row.id)
      ).toEqual(ancestors)
      snapshot = next
    }
    expect(
      getSidebarLineageAncestors(child, snapshot.lineageById, snapshot.worktreeMap)[0]?.displayName
    ).toBe('Renamed folder')
  })

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

    expect(getSidebarLineageParentsByIdentity(lineageById, secondAncestors)).toBe(
      getSidebarLineageParentsByIdentity(lineageById, firstAncestors)
    )
  })

  it('keeps archived candidates without injecting archived ancestors', () => {
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
    expect(Boolean(findWorktreeLineageRow(getLineageAncestorIndex(worktreesByRepo), parent))).toBe(
      true
    )
  })

  it('keeps both rows of a two-host id collision', () => {
    const local: Worktree = {
      ...makeWorktree('shared'),
      hostId: LOCAL_EXECUTION_HOST_ID,
      path: '/tmp/local'
    }
    const remote: Worktree = { ...makeWorktree('shared'), hostId: 'ssh:box', path: '/tmp/remote' }
    const worktreesByRepo = { repo1: [local, remote] }

    const index = getLineageAncestorIndex(worktreesByRepo)
    expect(findWorktreeLineageRow(index, local)?.path).toBe('/tmp/local')
    expect(findWorktreeLineageRow(index, remote)?.path).toBe('/tmp/remote')
  })
})

it('qualifies unstamped local admission without changing canonical bytes and keeps physical SSH owner precedence', () => {
  const previous = useAppStore.getState()
  const local = makeWorktree('shared')
  const remote = {
    ...local,
    hostId: 'runtime:e' as const,
    runtimeOwnerEnvironmentId: 'e',
    instanceId: 'remote'
  }
  try {
    useAppStore.setState({ worktreesByRepo: { repo1: [remote, local] }, folderWorkspaces: [] })
    expect(requireKnownLineageRow(useAppStore.getState(), local, 'local')).toBe(local)
    expect(local.hostId).toBeUndefined()
    expect(() => requireKnownLineageRow(useAppStore.getState(), local)).toThrow('changed')
    const ssh = { ...local, hostId: 'ssh:inner' as const, runtimeOwnerEnvironmentId: 'e' }
    useAppStore.setState({ worktreesByRepo: { repo1: [ssh] } })
    expect(requireKnownLineageRow(useAppStore.getState(), ssh, 'runtime:e')).toBe(ssh)
    expect(requireCurrentLineageRow(useAppStore.getState(), ssh)).toBe(ssh)
    useAppStore.setState({
      worktreesByRepo: { repo1: [ssh, { ...ssh, runtimeOwnerEnvironmentId: 'rival' }] }
    })
    expect(() => requireKnownLineageRow(useAppStore.getState(), ssh, 'runtime:e')).toThrow(
      'changed'
    )
  } finally {
    useAppStore.setState(previous, true)
  }
})
