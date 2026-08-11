import { describe, expect, it } from 'vitest'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  findIndexedWorktreeOwnerForHost
} from './worktree-runtime-owner-index'

describe('worktree runtime owner index', () => {
  it('indexes paired worktrees by both runtime owner and physical host', () => {
    const paired = {
      id: 'repo-1::same-id',
      repoId: 'repo-1',
      hostId: 'ssh:private-target' as const,
      runtimeOwnerEnvironmentId: 'hub-a'
    }
    const directSsh = {
      id: 'repo-1::direct',
      repoId: 'repo-1',
      hostId: 'ssh:direct-target' as const
    }
    const worktreesByRepo = { 'repo-1': [paired, directSsh] }

    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, paired.id, 'runtime:hub-a')).toBe(
      paired
    )
    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, paired.id, 'ssh:private-target')).toBe(
      paired
    )
    expect(
      findIndexedWorktreeOwnerForHost(worktreesByRepo, directSsh.id, 'ssh:direct-target')
    ).toBe(directSsh)
    expect(
      findIndexedWorktreeOwnerForHost(worktreesByRepo, directSsh.id, 'runtime:hub-a')
    ).toBeNull()
  })

  it('fails closed when direct and paired worktrees share a physical host alias', () => {
    const direct = {
      id: 'same-id',
      repoId: 'direct-repo',
      hostId: 'ssh:private-target' as const
    }
    const paired = {
      id: 'same-id',
      repoId: 'paired-repo',
      hostId: 'ssh:private-target' as const,
      runtimeOwnerEnvironmentId: 'hub-a'
    }

    for (const worktrees of [
      [direct, paired],
      [paired, direct]
    ]) {
      const worktreesByRepo = { repo: worktrees }
      expect(
        findIndexedWorktreeOwnerForHost(worktreesByRepo, 'same-id', 'ssh:private-target')
      ).toBeNull()
      expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, 'same-id', 'runtime:hub-a')).toBe(
        paired
      )
    }
  })

  it('fails closed when paired worktrees share a runtime host alias', () => {
    const pairedA = {
      id: 'same-id',
      repoId: 'repo-a',
      hostId: 'ssh:private-a' as const,
      runtimeOwnerEnvironmentId: 'hub-a'
    }
    const pairedB = {
      id: 'same-id',
      repoId: 'repo-b',
      hostId: 'ssh:private-b' as const,
      runtimeOwnerEnvironmentId: 'hub-a'
    }

    for (const worktrees of [
      [pairedA, pairedB],
      [pairedB, pairedA]
    ]) {
      const worktreesByRepo = { repo: worktrees }
      expect(
        findIndexedWorktreeOwnerForHost(worktreesByRepo, 'same-id', 'runtime:hub-a')
      ).toBeNull()
      expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, 'same-id', 'ssh:private-a')).toBe(
        pairedA
      )
      expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, 'same-id', 'ssh:private-b')).toBe(
        pairedB
      )
    }
  })

  it('fails closed when runtime catalog rows have different physical owners', () => {
    const localSource = {
      id: 'shared',
      projectGroupId: 'shared-group',
      executionHostId: 'runtime:hub-a' as const,
      runtimeSourceExecutionHostId: 'local' as const
    }
    const sshSource = {
      ...localSource,
      runtimeSourceExecutionHostId: 'ssh:private-target' as const
    }
    const groups = [
      {
        id: 'shared-group',
        executionHostId: 'runtime:hub-a' as const,
        runtimeSourceExecutionHostId: 'local' as const
      },
      {
        id: 'shared-group',
        executionHostId: 'runtime:hub-a' as const,
        runtimeSourceExecutionHostId: 'ssh:private-target' as const
      }
    ]

    expect(
      findIndexedFolderWorkspaceOwner([localSource, sshSource], 'shared', 'runtime:hub-a')
    ).toBeNull()
    expect(findIndexedFolderWorkspaceOwner([sshSource, localSource], 'shared', 'local')).toBe(
      localSource
    )
    expect(
      findIndexedFolderWorkspaceOwner([localSource, sshSource], 'shared', 'ssh:private-target')
    ).toBe(sshSource)
    expect(findIndexedProjectGroupOwner(groups, 'shared-group', 'runtime:hub-a')).toBeNull()
    expect(findIndexedProjectGroupOwner(groups, 'shared-group', 'local')).toBe(groups[0])
    expect(findIndexedProjectGroupOwner(groups, 'shared-group', 'ssh:private-target')).toBe(
      groups[1]
    )
  })

  it('omits contradictory direct catalog owners without rejecting runtime projection', () => {
    const invalidFolder = {
      id: 'invalid-folder',
      projectGroupId: 'group',
      executionHostId: 'local' as const,
      connectionId: 'builder'
    }
    const projectedFolder = {
      id: 'projected-folder',
      projectGroupId: 'group',
      executionHostId: 'runtime:hub-a' as const,
      runtimeSourceExecutionHostId: 'ssh:builder' as const,
      connectionId: 'builder'
    }

    expect(findIndexedFolderWorkspaceOwner([invalidFolder], invalidFolder.id, 'local')).toBeNull()
    expect(
      findIndexedFolderWorkspaceOwner([projectedFolder], projectedFolder.id, 'runtime:hub-a')
    ).toBe(projectedFolder)
  })

  it('fails closed when a folder id has conflicting group lineage on one host', () => {
    const first = {
      id: 'shared',
      projectGroupId: 'group-a',
      executionHostId: 'local' as const
    }
    const second = { ...first, projectGroupId: 'group-b' }

    expect(findIndexedFolderWorkspaceOwner([first, second], first.id, 'local')).toBeNull()
    expect(findIndexedFolderWorkspaceOwner([second, first], first.id, 'local')).toBeNull()
  })
})
