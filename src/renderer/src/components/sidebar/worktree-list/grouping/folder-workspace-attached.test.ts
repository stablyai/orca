import { describe, expect, it } from 'vitest'
import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { worktree } from '../../worktree-list-groups-test-fixtures'
import { getAttachedWorktreesByFolderWorkspaceId } from './folder-workspace-attached'

function attachedTo(
  worktreeId: string,
  overrides: Partial<WorkspaceLineage> = {}
): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(worktreeId),
    parentWorkspaceKey: folderWorkspaceKey('fw-1'),
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}

function lineageFor(worktreeId: string, overrides: Partial<WorkspaceLineage> = {}) {
  return { [worktreeWorkspaceKey(worktreeId)]: attachedTo(worktreeId, overrides) }
}

function attachedNames(worktrees: readonly Worktree[], lineage: Record<string, WorkspaceLineage>) {
  const attached = getAttachedWorktreesByFolderWorkspaceId(worktrees, lineage)
  return (attached.get('fw-1') ?? []).map((entry) => entry.displayName)
}

describe('getAttachedWorktreesByFolderWorkspaceId', () => {
  it('nests the only worktree carrying the id on a single host', () => {
    const names = attachedNames([worktree], lineageFor(worktree.id))

    expect(names).toEqual([worktree.displayName])
  })

  it('nests only the instance the record names when two hosts share the id', () => {
    const local: Worktree = {
      ...worktree,
      hostId: 'local',
      instanceId: 'instance-local',
      displayName: 'local row'
    }
    const remote: Worktree = {
      ...worktree,
      hostId: 'ssh:build-box',
      instanceId: 'instance-remote',
      displayName: 'remote row'
    }

    const names = attachedNames(
      [local, remote],
      lineageFor(worktree.id, { childInstanceId: 'instance-remote' })
    )

    expect(names).toEqual(['remote row'])
  })

  it('nests neither row when two hosts share the id and the record names no instance', () => {
    const local: Worktree = { ...worktree, hostId: 'local', displayName: 'local row' }
    const remote: Worktree = { ...worktree, hostId: 'ssh:build-box', displayName: 'remote row' }

    expect(attachedNames([local, remote], lineageFor(worktree.id))).toEqual([])
  })

  it('ignores a record whose child instance no longer matches', () => {
    const current: Worktree = { ...worktree, instanceId: 'current-instance' }

    const names = attachedNames(
      [current],
      lineageFor(worktree.id, { childInstanceId: 'instance-from-a-previous-checkout' })
    )

    expect(names).toEqual([])
  })

  it('ignores an archived child', () => {
    expect(attachedNames([{ ...worktree, isArchived: true }], lineageFor(worktree.id))).toEqual([])
  })

  it('ignores a record whose parent is another worktree', () => {
    const lineage = lineageFor(worktree.id, {
      parentWorkspaceKey: worktreeWorkspaceKey('wt-parent')
    })

    expect(getAttachedWorktreesByFolderWorkspaceId([worktree], lineage).size).toBe(0)
  })
})
