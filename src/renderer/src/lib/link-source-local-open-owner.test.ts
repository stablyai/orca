import { describe, expect, it } from 'vitest'
import { getLinkSourceLocalOpenOwner } from './link-source-local-open-owner'
import { isLocalPathOpenBlocked } from './local-path-open-guard'

const WORKTREE_ID = 'repo-1::/srv/worktree'

function stateWithWorktreeHost(hostId: 'local' | 'runtime:env-1') {
  return {
    // A focused server must not decide where a document lives.
    settings: { activeRuntimeEnvironmentId: 'env-1' },
    worktreesByRepo: { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', hostId }] }
  }
}

describe('getLinkSourceLocalOpenOwner', () => {
  it('allows a local worktree document while a server is focused', () => {
    const owner = getLinkSourceLocalOpenOwner(
      stateWithWorktreeHost('local'),
      { kind: 'local' },
      WORKTREE_ID
    )
    expect(owner).toBe('local')
    expect(isLocalPathOpenBlocked(owner)).toBe(false)
  })

  it('refuses a runtime-owned document that reports no connection', () => {
    const state = { ...stateWithWorktreeHost('runtime:env-1'), settings: null }
    const owner = getLinkSourceLocalOpenOwner(state, { kind: 'local' }, WORKTREE_ID)
    expect(owner).toBe('runtime:env-1')
    expect(isLocalPathOpenBlocked(owner)).toBe(true)
  })

  it('refuses a local-looking document whose worktree the catalog cannot place', () => {
    expect(getLinkSourceLocalOpenOwner({}, { kind: 'local' }, WORKTREE_ID)).toBe('unresolved')
  })

  it('keeps a document outside any worktree on this computer', () => {
    expect(getLinkSourceLocalOpenOwner({}, { kind: 'local' }, null)).toBe('local')
  })

  it('names runtime, SSH and unknown sources by their host', () => {
    expect(
      getLinkSourceLocalOpenOwner({}, { kind: 'runtime', runtimeEnvironmentId: 'env-2' }, null)
    ).toBe('runtime:env-2')
    expect(getLinkSourceLocalOpenOwner({}, { kind: 'ssh', connectionId: 'ssh-1' }, null)).toBe(
      'ssh:ssh-1'
    )
    expect(getLinkSourceLocalOpenOwner({}, { kind: 'unknown' }, null)).toBe('unresolved')
  })
})
