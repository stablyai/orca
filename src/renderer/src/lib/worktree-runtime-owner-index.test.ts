import { describe, expect, it } from 'vitest'
import {
  findIndexedDetectedWorktrees,
  findIndexedWorktreeOwnerForHost,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'

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

  it('unwraps canonical workspace keys before owner lookup', () => {
    const owner = {
      id: 'repo-1::same-id',
      repoId: 'repo-1',
      hostId: 'runtime:hub-a' as const
    }
    const worktreesByRepo = { 'repo-1': [owner] }
    const canonicalKey = worktreeWorkspaceKey(owner.id)

    expect(resolveIndexedWorktreeOwner(worktreesByRepo, canonicalKey)).toEqual({
      kind: 'resolved',
      owner
    })
    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, canonicalKey, 'runtime:hub-a')).toBe(
      owner
    )
  })

  it('fails closed for malformed scoped keys', () => {
    const owner = { id: 'repo-1', repoId: 'repo-1', hostId: 'local' as const }
    const worktreesByRepo = { 'repo-1': [owner] }
    const detectedWorktreesByRepo = { 'repo-1': { worktrees: [owner] } }

    expect(resolveIndexedWorktreeOwner(worktreesByRepo, 'worktree:repo-1')).toEqual({
      kind: 'missing'
    })
    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, 'folder:repo-1', 'local')).toBeNull()
    expect(findIndexedDetectedWorktrees(detectedWorktreesByRepo, 'worktree:repo-1')).toEqual([])
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

  it('treats inferred and explicit equivalent SSH repo owners as one owner', () => {
    const inferred = { id: 'repo-ssh', connectionId: 'ssh-1', executionHostId: null } as const
    const explicit = {
      id: 'repo-ssh',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    } as const

    expect(resolveIndexedRepoOwner([inferred, explicit], 'repo-ssh')).toEqual({
      kind: 'resolved',
      owner: inferred
    })
  })

  it('treats omitted and runtime-stamped equivalent worktree owners as one owner', () => {
    const omitted = {
      id: 'repo-runtime::/same-path',
      repoId: 'repo-runtime',
      runtimeOwnerEnvironmentId: 'hub-a'
    } as const
    const stamped = {
      ...omitted,
      hostId: 'runtime:hub-a' as const
    }
    const worktreesByRepo = { 'repo-runtime': [omitted, stamped] }

    expect(resolveIndexedWorktreeOwner(worktreesByRepo, omitted.id)).toEqual({
      kind: 'resolved',
      owner: omitted
    })
  })
})
