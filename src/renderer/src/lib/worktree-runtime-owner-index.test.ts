import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  findIndexedProjectGroupOwner,
  findIndexedWorktreeOwnerForHost,
  isProjectGroupIdAmbiguous
} from './worktree-runtime-owner-index'

describe('worktree runtime owner index', () => {
  it('preserves full project-group records while resolving host-qualified ids', () => {
    const local = { id: 'group-1', name: 'Local group', executionHostId: 'local' }
    const remote = { id: 'group-1', name: 'Remote group', executionHostId: 'ssh:target' }
    const groups = [local, remote]

    expect(isProjectGroupIdAmbiguous(groups, 'group-1')).toBe(true)
    expect(findIndexedProjectGroupOwner(groups, 'group-1')).toBeNull()
    const owner = findIndexedProjectGroupOwner(groups, 'group-1', 'ssh:target')
    expect(owner).toBe(remote)
    expectTypeOf(owner).toEqualTypeOf<typeof remote | null>()
  })

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
})
