import { describe, expect, it } from 'vitest'
import { resolveTerminalHostOwnership, resolveTerminalPtyOwner } from './terminal-worktree-route'
import { resolveOwner } from './resolve-owner'
import { OWNER_RESOLUTION_CASES } from './runtime-owner-alias-matrix.test-fixture'
import { LEGACY_RUNTIME_OWNER_GOLDEN } from './legacy-runtime-owner-answers.test-fixture'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

const describeOwner = (owner: ReturnType<typeof resolveTerminalPtyOwner>) =>
  owner.kind === 'runtime' ? owner.environmentId : owner.kind === 'ambiguous' ? 'ambiguous' : null

// Each deliberate change from the deleted resolver's teardown answer (round-3 design §3, §4, §7).
const DELIBERATE_CHANGES: Record<string, string | null> = {
  // C: teardown follows spawn, which already starts these PTYs on the server.
  'focused | stale-hub-repo::wt': 'hub-env',
  'no focus | stale-hub-repo::wt': 'hub-env',
  'single focus | stale-hub-repo::wt': 'hub-env',
  // D77: a folder twin names no host; only each PTY's own `remote:<env>` id may.
  'focused | folder:twin-folder': 'ambiguous',
  'no focus | folder:twin-folder': 'ambiguous',
  'single focus | folder:twin-folder': 'ambiguous',
  'focused | folder:group-twin-folder': 'ambiguous',
  'no focus | folder:group-twin-folder': 'ambiguous',
  'single focus | folder:group-twin-folder': 'ambiguous',
  // B: two servers contest the selected SSH host, so spawn refuses and teardown must too.
  'active ssh:box | rival-repo::wt': 'ambiguous',
  'active ssh:box | conflict-repo::wt': 'ambiguous'
}

describe('resolveTerminalPtyOwner acceptance', () => {
  it('answers as the deleted resolver did, except the deliberate cases', () => {
    const actual = Object.fromEntries(
      OWNER_RESOLUTION_CASES.map((c) => [
        c.name,
        describeOwner(resolveTerminalPtyOwner(c.state, c.worktreeId))
      ])
    )
    expect(actual).toEqual({ ...LEGACY_RUNTIME_OWNER_GOLDEN, ...DELIBERATE_CHANGES })
    for (const name of Object.keys(DELIBERATE_CHANGES)) {
      expect(LEGACY_RUNTIME_OWNER_GOLDEN[name], name).not.toBe(DELIBERATE_CHANGES[name])
    }
  })

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
