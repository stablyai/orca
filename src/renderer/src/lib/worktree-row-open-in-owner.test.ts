import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { resolveWorktreeRowOpenInRuntimeOwner } from './worktree-row-open-in-owner'
import { getExternalEditorOpenCapability } from './external-editor-open-capability'
import { isLocalPathOpenBlocked } from './local-path-open-guard'

const WORKTREE_ID = 'repo-1::/srv/worktree'

function worktree(hostId: Worktree['hostId'], runtimeOwnerEnvironmentId?: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only id/repoId/hostId/runtimeOwnerEnvironmentId.
  return {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/srv/worktree',
    hostId,
    runtimeOwnerEnvironmentId
  } as Worktree
}

// Two paired servers provisioned from one profile publish the same id and SSH host.
const rivalHubState = {
  settings: { activeRuntimeEnvironmentId: null },
  worktreesByRepo: {
    'repo-1': [
      worktree('ssh:same-private-target', 'hub-a'),
      worktree('ssh:same-private-target', 'hub-b')
    ]
  }
}

describe('resolveWorktreeRowOpenInRuntimeOwner', () => {
  it('keeps the clicked row stamped owner when rival HUBs share its SSH host', () => {
    expect(
      resolveWorktreeRowOpenInRuntimeOwner(
        rivalHubState,
        worktree('ssh:same-private-target', 'hub-b')
      )
    ).toEqual({ runtimeEnvironmentId: 'hub-b', ownerUnresolved: false })
  })

  it('reports an unstamped row on a rival-HUB host as unresolved, never as desktop-owned', () => {
    const owner = resolveWorktreeRowOpenInRuntimeOwner(
      rivalHubState,
      worktree('ssh:same-private-target')
    )
    expect(owner).toEqual({ runtimeEnvironmentId: null, ownerUnresolved: true })
    const context = { connectionId: null, command: 'code', ...owner }
    expect(getExternalEditorOpenCapability(rivalHubState.settings, context)).toEqual({
      allowed: false,
      reason: 'remote-runtime'
    })
    expect(isLocalPathOpenBlocked(rivalHubState.settings, context)).toBe(true)
  })

  it('recovers a single HUB owner for an unstamped row on its SSH host', () => {
    expect(
      resolveWorktreeRowOpenInRuntimeOwner(
        { worktreesByRepo: { 'repo-1': [worktree('ssh:hub-private-target', 'hub-a')] } },
        worktree('ssh:hub-private-target')
      )
    ).toEqual({ runtimeEnvironmentId: 'hub-a', ownerUnresolved: false })
  })

  it('keeps a direct SSH row resolved with no runtime', () => {
    expect(
      resolveWorktreeRowOpenInRuntimeOwner(
        {
          repos: [{ id: 'repo-1', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }],
          worktreesByRepo: { 'repo-1': [worktree('ssh:ssh-1')] }
        },
        worktree('ssh:ssh-1')
      )
    ).toEqual({ runtimeEnvironmentId: null, ownerUnresolved: false })
  })

  it('keeps a local row resolved as desktop-owned', () => {
    expect(resolveWorktreeRowOpenInRuntimeOwner({}, worktree('local'))).toEqual({
      runtimeEnvironmentId: null,
      ownerUnresolved: false
    })
  })
})
