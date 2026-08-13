import { describe, expect, it } from 'vitest'
import { canSeedCreatedWorktreeInBackground } from './worktree-creation-terminal-handoff'

function stateWithOwners(owners: { id: string; repoId: string; hostId?: string }[]): never {
  return {
    repos: owners.map((owner) => ({
      id: owner.repoId,
      connectionId: owner.hostId?.startsWith('ssh:') ? owner.hostId.slice(4) : null,
      executionHostId: owner.hostId
    })),
    worktreesByRepo: { repo: owners },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [],
    settings: {}
  } as never
}

describe('created worktree background terminal handoff', () => {
  it('fails closed when sibling hosts publish the same worktree id', () => {
    const id = 'repo::/workspace'
    const state = stateWithOwners([
      { id, repoId: 'repo', hostId: 'ssh:first' },
      { id, repoId: 'repo', hostId: 'ssh:second' }
    ])

    expect(canSeedCreatedWorktreeInBackground(state, { id, hostId: 'ssh:second' })).toBe(false)
  })

  it('allows a uniquely resolved host and preserves legacy hostless behavior', () => {
    const id = 'repo::/workspace'
    const state = stateWithOwners([{ id, repoId: 'repo', hostId: 'ssh:requested' }])

    expect(canSeedCreatedWorktreeInBackground(state, { id, hostId: 'ssh:requested' })).toBe(true)
    expect(canSeedCreatedWorktreeInBackground(state, { id })).toBe(true)
  })
})
