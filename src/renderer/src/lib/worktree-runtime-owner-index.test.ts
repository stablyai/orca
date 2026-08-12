import { describe, expect, it } from 'vitest'
import { findIndexedWorktreeOwnerForHost } from './worktree-runtime-owner-index'

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
})
