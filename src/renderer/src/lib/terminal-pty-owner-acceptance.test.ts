import { describe, expect, it } from 'vitest'
import { resolveTerminalHostOwnership, resolveTerminalPtyOwner } from './terminal-worktree-route'
import { resolveOwner } from './resolve-owner'
import { OWNER_RESOLUTION_CASES } from './runtime-owner-alias-matrix.test-fixture'

import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

describe('resolveTerminalPtyOwner acceptance', () => {
  it('keeps a setup terminal and a row-less worktree local under single focus', () => {
    const single = OWNER_RESOLUTION_CASES.find((c) => c.name === 'single focus | legacy-repo::wt')!
    expect(resolveTerminalPtyOwner(single.state, 'ephemeral-setup-terminal:skill-panel')).toEqual({
      kind: 'non-runtime'
    })
    expect(resolveTerminalPtyOwner(single.state, 'unknown-repo::wt')).toEqual({
      kind: 'non-runtime'
    })
  })
})

describe('the contested-target rule for a selected ssh: host', () => {
  const directAndProxied: WorktreeRuntimeOwnerState = {
    settings: { activeRuntimeEnvironmentId: null },
    runtimeEnvironments: [{ id: 'hub-env' }],
    runtimeEnvironmentCatalogHydrated: true,
    repos: [
      { id: 'repo', connectionId: 'box', executionHostId: 'ssh:box' },
      { id: 'repo', connectionId: 'box', executionHostId: 'runtime:hub-env' }
    ],
    worktreesByRepo: { repo: [{ id: 'repo::wt', repoId: 'repo', hostId: 'ssh:box' }] },
    activeWorktreeId: 'repo::wt',
    activeWorkspaceExecutionHostId: 'ssh:box'
  }

  it('dials a proven direct listing directly although a server proxies the same target id', () => {
    expect(resolveOwner(directAndProxied, { workspaceId: 'repo::wt' })).toEqual({
      kind: 'resolved',
      owner: { endpoint: { kind: 'self' }, at: 'ssh:box' }
    })
    expect(resolveTerminalHostOwnership(directAndProxied, 'repo::wt', 'spawn').kind).toBe(
      'local-or-ssh'
    )
    expect(resolveTerminalPtyOwner(directAndProxied, 'repo::wt')).toEqual({ kind: 'non-runtime' })
  })

  it('refuses when no direct repo row backs the listing', () => {
    const proxiedTwice: WorktreeRuntimeOwnerState = {
      ...directAndProxied,
      repos: [
        { id: 'repo', connectionId: 'box', executionHostId: 'runtime:hub-a' },
        { id: 'repo', connectionId: 'box', executionHostId: 'runtime:hub-b' }
      ]
    }
    expect(resolveOwner(proxiedTwice, { workspaceId: 'repo::wt' })).toEqual({ kind: 'ambiguous' })
    expect(resolveTerminalHostOwnership(proxiedTwice, 'repo::wt', 'spawn').kind).toBe('unresolved')
    expect(resolveTerminalPtyOwner(proxiedTwice, 'repo::wt')).toEqual({ kind: 'ambiguous' })
  })

  it('still dials a proven direct listing when two servers proxy the same target id', () => {
    const directAndTwoProxies: WorktreeRuntimeOwnerState = {
      ...directAndProxied,
      repos: [
        { id: 'repo', connectionId: 'box', executionHostId: 'ssh:box' },
        { id: 'repo', connectionId: 'box', executionHostId: 'runtime:hub-a' },
        { id: 'repo', connectionId: 'box', executionHostId: 'runtime:hub-b' }
      ]
    }
    expect(resolveOwner(directAndTwoProxies, { workspaceId: 'repo::wt' })).toEqual({
      kind: 'resolved',
      owner: { endpoint: { kind: 'self' }, at: 'ssh:box' }
    })
    expect(resolveTerminalPtyOwner(directAndTwoProxies, 'repo::wt')).toEqual({
      kind: 'non-runtime'
    })
  })
})
