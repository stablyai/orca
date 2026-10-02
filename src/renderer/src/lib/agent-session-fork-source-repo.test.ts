import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

const settingsForRepoOwner = vi.hoisted(() =>
  vi.fn((_state: unknown, _repoId: string, _hostId?: string) => ({ routed: true }))
)
vi.mock('@/store/repos/owner-routing', () => ({ settingsForRepoOwner }))

const { findForkWorktreeRepo, forkWorktreeOwnerSettings } =
  await import('./agent-session-fork-source-repo')

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo',
    path: '/r',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

const localRepo = repo({})
const sshRepo = repo({ connectionId: 'ssh-1' })
const runtimeRepo = repo({ executionHostId: 'runtime:env-1' })
const state = { repos: [localRepo, sshRepo, runtimeRepo], settings: null }

describe('findForkWorktreeRepo', () => {
  it("picks the repo on the worktree's own host when repo ids collide", () => {
    expect(findForkWorktreeRepo(state, { repoId: 'repo', hostId: 'ssh:ssh-1' })).toBe(sshRepo)
    expect(findForkWorktreeRepo(state, { repoId: 'repo', hostId: 'local' })).toBe(localRepo)
  })

  it('keys a runtime-owned worktree by its runtime, not the host-side id', () => {
    expect(
      findForkWorktreeRepo(state, {
        repoId: 'repo',
        hostId: 'local',
        runtimeOwnerEnvironmentId: 'env-1'
      })
    ).toBe(runtimeRepo)
  })

  it('falls back to the bare id for legacy rows without a host', () => {
    expect(findForkWorktreeRepo({ repos: [sshRepo], settings: null }, { repoId: 'repo' })).toBe(
      sshRepo
    )
  })

  it('routes owner settings through the same repo', () => {
    expect(forkWorktreeOwnerSettings(state, { repoId: 'repo', hostId: 'ssh:ssh-1' })).toEqual({
      routed: true
    })
    expect(settingsForRepoOwner).toHaveBeenLastCalledWith(state, 'repo', 'ssh:ssh-1')
  })
})
