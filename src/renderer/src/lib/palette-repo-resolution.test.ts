import { describe, expect, it } from 'vitest'
import {
  buildPaletteWorktreeIndex,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree,
  resolvePaletteWorktree
} from './palette-repo-resolution'

describe('palette repo and current-worktree resolution', () => {
  const local = { id: 'repo-1', displayName: 'Local repo' }
  const remote = { id: 'repo-1', displayName: 'Remote repo' }
  const worktree = { id: 'repo-1::/checkout', repoId: 'repo-1', hostId: 'ssh:box' as const }

  it('uses the host-qualified repo for a colliding worktree', () => {
    expect(
      resolvePaletteRepoForWorktree(
        worktree,
        new Map([['repo-1', local]]),
        new Map([['ssh:box\u0000repo-1', remote]])
      )
    ).toBe(remote)
  })

  it('uses the runtime-owned repo for a paired SSH worktree', () => {
    expect(
      resolvePaletteRepoForWorktree(
        { ...worktree, runtimeOwnerEnvironmentId: 'paired-host' },
        new Map([['repo-1', local]]),
        new Map([['runtime:paired-host\u0000repo-1', remote]])
      )
    ).toBe(remote)
  })

  it('does not borrow repo metadata when the runtime owner is unavailable', () => {
    expect(
      resolvePaletteRepoForWorktree(
        { ...worktree, runtimeOwnerEnvironmentId: 'missing-host' },
        new Map([['repo-1', local]]),
        new Map([['ssh:box\u0000repo-1', remote]])
      )
    ).toBeUndefined()
  })

  it('does not mark a same-id worktree on another host current', () => {
    expect(isPaletteCurrentWorktree(worktree, worktree.id, 'local')).toBe(false)
    expect(isPaletteCurrentWorktree(worktree, worktree.id, 'ssh:box')).toBe(true)
  })

  it('recognizes the paired-runtime alias of an SSH worktree as current', () => {
    expect(
      isPaletteCurrentWorktree(
        { ...worktree, runtimeOwnerEnvironmentId: 'paired-host' },
        worktree.id,
        'runtime:paired-host'
      )
    ).toBe(true)
  })

  it('resolves a paired SSH worktree through its runtime owner alias', () => {
    const localWorktree = {
      ...worktree,
      hostId: 'local' as const,
      displayName: 'Local workspace'
    }
    const pairedWorktree = {
      ...worktree,
      hostId: 'ssh:private-target' as const,
      runtimeOwnerEnvironmentId: 'paired-host',
      displayName: 'Remote workspace'
    }
    const index = buildPaletteWorktreeIndex([localWorktree, pairedWorktree])

    expect(resolvePaletteWorktree(index, worktree.id, 'runtime:paired-host')).toBe(pairedWorktree)
  })

  it('does not fall back to another host for an explicit owner', () => {
    const localWorktree = { ...worktree, hostId: 'local' as const }
    const index = buildPaletteWorktreeIndex([localWorktree])

    expect(resolvePaletteWorktree(index, worktree.id, 'runtime:missing-host')).toBeUndefined()
  })

  it('resolves a hostless legacy worktree for a local-owned tab', () => {
    const localWorktree = { ...worktree, hostId: undefined }
    const index = buildPaletteWorktreeIndex([localWorktree])

    expect(resolvePaletteWorktree(index, worktree.id, 'local')).toBe(localWorktree)
  })
})
