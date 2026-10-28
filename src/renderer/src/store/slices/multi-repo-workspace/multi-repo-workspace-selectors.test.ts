import { describe, expect, it } from 'vitest'
import type { MultiRepoMember } from '../../../../../shared/multi-repo-workspace'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import {
  collectMultiRepoMemberIdentities,
  deriveMultiRepoMemberViews,
  summarizeMultiRepoWorkspace
} from './multi-repo-workspace-selectors'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../shared/worktree/host-qualified-identity'
import { parseMultiRepoWorkspaceError } from './multi-repo-workspace-transport'

function member(overrides: Partial<MultiRepoMember> & { memberId: string }): MultiRepoMember {
  return {
    repoId: overrides.memberId,
    dirName: overrides.memberId,
    branchName: 'feature',
    state: 'ready',
    attempts: 1,
    worktreeId: `${overrides.memberId}::wt`,
    ...overrides
  }
}

const workspace = (members: MultiRepoMember[]) => ({
  multiRepo: {
    version: 1 as const,
    executionHostId: 'local' as const,
    rootOwnedByOrca: true,
    members
  }
})

describe('deriveMultiRepoMemberViews', () => {
  it('marks removed projects and vanished worktrees without flagging unloaded lists', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal repo fixtures; the selector reads only id.
    const repos = [{ id: 'api' }, { id: 'web' }, { id: 'infra' }] as Repo[]
    const views = deriveMultiRepoMemberViews(
      workspace([
        member({ memberId: 'api' }),
        member({ memberId: 'web' }),
        member({ memberId: 'infra' }),
        member({ memberId: 'gone' })
      ]),
      repos,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal worktree fixture; the selector reads only id.
      { api: [{ id: 'api::wt' } as Worktree], web: [] }
    )
    expect(views.map((view) => view.availability)).toEqual([
      'ok',
      'missing',
      'ok',
      'project_removed'
    ])
  })

  it('returns nothing for a plain folder workspace', () => {
    expect(deriveMultiRepoMemberViews({}, [], {})).toEqual([])
  })
})

describe('summarizeMultiRepoWorkspace', () => {
  it('counts states and members with changes', () => {
    const views = deriveMultiRepoMemberViews(
      workspace([
        member({ memberId: 'api' }),
        member({ memberId: 'web', state: 'failed', worktreeId: undefined }),
        member({ memberId: 'infra', state: 'creating', worktreeId: undefined })
      ]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal repo fixtures; the selector reads only id.
      [{ id: 'api' }, { id: 'web' }, { id: 'infra' }] as Repo[],
      {}
    )
    const summary = summarizeMultiRepoWorkspace(views, new Map([['api', 3]]))
    expect(summary).toMatchObject({
      total: 3,
      ready: 1,
      failed: 1,
      creating: 1,
      remaining: 1,
      changed: 3,
      withChanges: 1
    })
  })
})

describe('parseMultiRepoWorkspaceError', () => {
  it('reads the code from a local IPC message', () => {
    const parsed = parseMultiRepoWorkspaceError(
      new Error("Error invoking remote method 'x': Error: multi_repo_has_members: still has repos")
    )
    expect(parsed?.code).toBe('multi_repo_has_members')
    expect(parsed?.message).toBe('still has repos')
  })

  it('ignores unrelated errors', () => {
    expect(parseMultiRepoWorkspaceError(new Error('boom'))).toBeNull()
  })
})

describe('collectMultiRepoMemberIdentities', () => {
  it('collects only members that hold a worktree, scoped to the workspace host', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the collector reads only multiRepo.members and executionHostId.
    const workspaces = [
      workspace([
        member({ memberId: 'a' }),
        member({ memberId: 'b', state: 'failed', worktreeId: undefined })
      ]),
      { multiRepo: undefined },
      workspace([member({ memberId: 'c' })])
    ] as unknown as FolderWorkspace[]
    const identities = collectMultiRepoMemberIdentities(workspaces)
    expect([...identities]).toEqual([
      composeWorktreeHostIdentity('local', 'a::wt'),
      composeWorktreeHostIdentity('local', 'c::wt')
    ])
  })

  it('locks only the workspace host copy when another host has a worktree with the same id', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the collector reads only multiRepo.members and executionHostId.
    const identities = collectMultiRepoMemberIdentities([
      workspace([member({ memberId: 'a' })])
    ] as unknown as FolderWorkspace[])
    expect(identities.has(getWorktreeHostIdentity({ id: 'a::wt', hostId: 'local' }))).toBe(true)
    expect(identities.has(getWorktreeHostIdentity({ id: 'a::wt', hostId: 'runtime:env-a' }))).toBe(
      false
    )
  })

  it('scopes a remote runtime workspace to the adopted host, not the one the host wrote', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the collector reads only multiRepo.members and executionHostId.
    const identities = collectMultiRepoMemberIdentities([
      { ...workspace([member({ memberId: 'a' })]), executionHostId: 'runtime:env-a' }
    ] as unknown as FolderWorkspace[])
    expect(identities.has(getWorktreeHostIdentity({ id: 'a::wt', hostId: 'runtime:env-a' }))).toBe(
      true
    )
    expect(identities.has(getWorktreeHostIdentity({ id: 'a::wt', hostId: 'local' }))).toBe(false)
  })
})
