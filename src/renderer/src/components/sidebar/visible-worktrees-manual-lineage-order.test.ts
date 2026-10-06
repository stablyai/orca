import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { worktree, repoMap } from './worktree-list-groups-test-fixtures'
import { computeVisibleWorktrees, type VisibleWorktreeOptions } from './visible-worktrees'
import { buildRows } from './worktree-list/grouping/build-rows'

function scenario(hostId: ExecutionHostId) {
  const parent = { ...worktree, id: 'parent', instanceId: 'parent-instance', hostId }
  const child = { ...worktree, id: 'child', instanceId: 'child-instance', hostId }
  const sibling = { ...worktree, id: 'sibling', instanceId: 'sibling-instance', hostId }
  const lineage: WorktreeLineage = {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
  const options: VisibleWorktreeOptions = {
    filterRepoIds: [],
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
    worktreeLineageById: { [child.id]: lineage }
  }
  const worktreesByRepo = { [worktree.repoId]: [parent, child, sibling] }
  const sortedIds = [child.id, sibling.id, parent.id]
  function renderedIds(overrides: Partial<VisibleWorktreeOptions> = {}): string[] {
    const visible = computeVisibleWorktrees(worktreesByRepo, sortedIds, {
      ...options,
      ...overrides
    })
    return buildRows(
      'none',
      visible,
      repoMap,
      {},
      new Set(),
      new Map(),
      [],
      undefined,
      options.worktreeLineageById,
      new Map([parent, child, sibling].map((row) => [row.id, row])),
      true
    ).flatMap((row) => (row.type === 'item' ? [row.worktree.id] : []))
  }
  return { renderedIds }
}

describe.each(['local', 'ssh:remote'] as const)('manual lineage order on %s', (hostId) => {
  it('keeps a parent below its neighbor despite higher-ranked children', () => {
    expect(scenario(hostId).renderedIds({ preserveLineageParentOrder: true })).toEqual([
      'sibling',
      'parent',
      'child'
    ])
  })

  it('keeps a filtered structural parent in its manual position', () => {
    expect(
      scenario(hostId).renderedIds({
        preserveLineageParentOrder: true,
        showSleepingWorkspaces: false,
        worktreeIdsWithLiveAgent: new Set(['child', 'sibling'])
      })
    ).toEqual(['sibling', 'parent', 'child'])
  })

  it('continues promoting a parent with its children for automatic sorts', () => {
    expect(scenario(hostId).renderedIds()).toEqual(['parent', 'child', 'sibling'])
  })
})
