import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { resolveWorktreeRowOpenInRuntimeOwner } from './worktree-row-open-in-owner'
import { getExternalEditorOpenCapability } from './external-editor-open-capability'
import { getLocalPathOpenOwnerForRoute, isLocalPathOpenBlocked } from './local-path-open-guard'
import { OWNER_RESOLUTION_CASES } from './runtime-owner-alias-matrix.test-fixture'

describe('an unhosted row resolves through the fold adapter', () => {
  const caseState = (name: string) => OWNER_RESOLUTION_CASES.find((c) => c.name === name)!.state
  const row = (id: string, repoId: string) => ({ id, repoId, hostId: undefined })

  it('leaves a git twin unresolved instead of launching it as this desktop checkout', () => {
    expect(
      resolveWorktreeRowOpenInRuntimeOwner(
        caseState('focused | projected-twin::wt'),
        row('projected-twin::wt', 'projected-twin')
      ).ownerUnresolved
    ).toBe(true)
  })

  it('routes a row whose only repo row is a server proxying its target through that server', () => {
    expect(
      resolveWorktreeRowOpenInRuntimeOwner(
        caseState('focused | stale-hub-repo::wt'),
        row('stale-hub-repo::wt', 'stale-hub-repo')
      )
    ).toEqual({ runtimeEnvironmentId: 'hub-env', connectionId: null, ownerUnresolved: false })
  })
})

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
    ).toEqual({ runtimeEnvironmentId: 'hub-b', connectionId: null, ownerUnresolved: false })
  })

  it('reports an unstamped row on a rival-HUB host as unresolved, never as desktop-owned', () => {
    const owner = resolveWorktreeRowOpenInRuntimeOwner(
      rivalHubState,
      worktree('ssh:same-private-target')
    )
    expect(owner).toEqual({ runtimeEnvironmentId: null, connectionId: null, ownerUnresolved: true })
    const context = { command: 'code', ...owner }
    expect(getExternalEditorOpenCapability(context)).toEqual({
      allowed: false,
      reason: 'remote-runtime'
    })
    expect(isLocalPathOpenBlocked(getLocalPathOpenOwnerForRoute(context))).toBe(true)
  })

  it('recovers a single HUB owner for an unstamped row on its SSH host', () => {
    expect(
      resolveWorktreeRowOpenInRuntimeOwner(
        { worktreesByRepo: { 'repo-1': [worktree('ssh:hub-private-target', 'hub-a')] } },
        worktree('ssh:hub-private-target')
      )
    ).toEqual({ runtimeEnvironmentId: 'hub-a', connectionId: null, ownerUnresolved: false })
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
    ).toEqual({ runtimeEnvironmentId: null, connectionId: 'ssh-1', ownerUnresolved: false })
  })

  it('names the SSH target of a host-only SSH row that has no repo connection', () => {
    const owner = resolveWorktreeRowOpenInRuntimeOwner(
      {
        repos: [{ id: 'repo-1', executionHostId: 'ssh:ssh-1' }],
        worktreesByRepo: { 'repo-1': [worktree(undefined)] }
      },
      worktree(undefined)
    )
    expect(owner).toEqual({
      runtimeEnvironmentId: null,
      connectionId: 'ssh-1',
      ownerUnresolved: false
    })
    expect(isLocalPathOpenBlocked(getLocalPathOpenOwnerForRoute(owner))).toBe(true)
  })

  it('names the SSH target of a direct-SSH folder workspace row, which has no repo', () => {
    const folderRow = { id: 'folder:fw-1', hostId: 'ssh:ssh-1' as const }
    const owner = resolveWorktreeRowOpenInRuntimeOwner(
      {
        folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'group-1', connectionId: 'ssh-1' }],
        projectGroups: [{ id: 'group-1', connectionId: 'ssh-1' }]
      },
      folderRow
    )
    expect(owner).toEqual({
      runtimeEnvironmentId: null,
      connectionId: 'ssh-1',
      ownerUnresolved: false
    })
    expect(isLocalPathOpenBlocked(getLocalPathOpenOwnerForRoute(owner))).toBe(true)
  })

  it('keeps a local row resolved as desktop-owned', () => {
    expect(resolveWorktreeRowOpenInRuntimeOwner({}, worktree('local'))).toEqual({
      runtimeEnvironmentId: null,
      connectionId: null,
      ownerUnresolved: false
    })
  })
})
