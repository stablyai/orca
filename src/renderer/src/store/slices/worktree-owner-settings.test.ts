import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { replaceWorktreeInRepoLists } from './worktrees/listing/worktree-owner-settings'

const ID = 'repo-1::/workspace'

function worktree(overrides: Partial<Worktree>): Worktree {
  return { id: ID, repoId: 'repo-1', path: '/workspace', ...overrides } as Worktree
}

describe('replaceWorktreeInRepoLists', () => {
  it('replaces only the matching host when ids collide across hosts', () => {
    const local = worktree({ hostId: 'local', head: 'local-head' })
    const remote = worktree({ hostId: 'ssh:builder', head: 'remote-head' })
    const updatedRemote = worktree({ hostId: 'ssh:builder', head: 'remote-new-head' })

    const result = replaceWorktreeInRepoLists({ 'repo-1': [local, remote] }, updatedRemote)

    expect(result['repo-1']).toEqual([local, updatedRemote])
  })

  it('matches paired HUB rows by logical runtime owner across physical host stamps', () => {
    const existing = worktree({
      hostId: 'ssh:builder-private',
      runtimeOwnerEnvironmentId: 'hub-a',
      head: 'old'
    })
    const updated = worktree({
      hostId: 'runtime:hub-a',
      runtimeOwnerEnvironmentId: 'hub-a',
      head: 'new'
    })

    const result = replaceWorktreeInRepoLists({ 'repo-1': [existing] }, updated)

    expect(result['repo-1']).toEqual([updated])
  })

  it('preserves sibling SSH rows when physical hosts share a runtime owner', () => {
    const sshA = worktree({
      hostId: 'ssh:A',
      runtimeOwnerEnvironmentId: 'hub',
      head: 'a-old'
    })
    const sshB = worktree({
      hostId: 'ssh:B',
      runtimeOwnerEnvironmentId: 'hub',
      head: 'b-old'
    })
    const updatedA = worktree({
      hostId: 'ssh:A',
      runtimeOwnerEnvironmentId: 'hub',
      head: 'a-new'
    })

    const result = replaceWorktreeInRepoLists({ 'repo-1': [sshA, sshB] }, updatedA)

    expect(result['repo-1']).toEqual([updatedA, sshB])
  })
})
