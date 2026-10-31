import { describe, expect, it } from 'vitest'
import {
  findIndexedWorktreeOwnerForHost,
  findIndexedProjectGroupDisplay,
  resolveIndexedProjectGroupOwner,
  worktreeOwnerHostIds
} from './worktree-runtime-owner-index'

describe('worktree runtime owner index', () => {
  it('treats a legacy worktree without a host as local', () => {
    const legacy = { id: 'legacy', repoId: 'repo-1' }
    const worktreesByRepo = { 'repo-1': [legacy] }

    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, legacy.id, 'local')).toBe(legacy)
    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, legacy.id, 'runtime:hub-a')).toBeNull()
    expect(worktreeOwnerHostIds(legacy)).toEqual(['local'])
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

    expect(worktreeOwnerHostIds(paired)).toEqual(['ssh:private-target', 'runtime:hub-a'])

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

describe('raw folder group display and ownership products', () => {
  it.each(['owner-first', 'display-first'])(
    'shares one build in %s order while keeping first display separate from routing',
    (order) => {
      let reads = 0
      const first = {
        get id() {
          reads++
          return 'twin'
        },
        name: 'First',
        executionHostId: 'local'
      }
      const sameHost = { id: 'twin', name: '', executionHostId: 'local' }
      const remote = { id: 'twin', name: 'Remote', executionHostId: 'runtime:server' }
      const nul = { id: 'twin\0local', name: 'Bare NUL', executionHostId: 'local' }
      const rows = [first, sameHost, remote, nul]
      if (order === 'owner-first') {
        resolveIndexedProjectGroupOwner(rows, 'twin')
      } else {
        expect(findIndexedProjectGroupDisplay(rows, 'twin')).toBe(first)
      }
      const built = reads
      expect(built).toBeGreaterThan(0)
      expect(findIndexedProjectGroupDisplay(rows, 'twin')).toBe(first)
      expect(findIndexedProjectGroupDisplay(rows, 'twin\0local')).toBe(nul)
      expect(findIndexedProjectGroupDisplay(rows, 'absent')).toBeUndefined()
      expect(resolveIndexedProjectGroupOwner(rows, 'twin')).toEqual({ kind: 'ambiguous' })
      // Existing qualified namespace collision is unchanged; display has its own exact table.
      expect(resolveIndexedProjectGroupOwner(rows, 'twin', 'local')).toEqual({
        kind: 'resolved',
        owner: sameHost
      })
      expect(resolveIndexedProjectGroupOwner(rows, 'twin', 'runtime:server')).toEqual({
        kind: 'resolved',
        owner: remote
      })
      expect(reads).toBe(built)
      expect(findIndexedProjectGroupDisplay([remote, first], 'twin')).toBe(remote)
      expect(findIndexedProjectGroupDisplay([sameHost, remote], 'twin')?.name).toBe('')
      expect(resolveIndexedProjectGroupOwner([first, sameHost], 'twin')).toEqual({
        kind: 'resolved',
        owner: first
      })
      expect(resolveIndexedProjectGroupOwner([], 'missing')).toEqual({ kind: 'missing' })
    }
  )
})
