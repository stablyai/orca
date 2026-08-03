import { describe, expect, it } from 'vitest'
import { getRepoDisplayLabelKey, getRepoDisplayLabelsByPath } from './repo-display-labels'

describe('getRepoDisplayLabelsByPath', () => {
  it('keeps non-colliding repository names basename-only', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/platform/web', displayName: 'web' },
      { path: '/workspace/platform/worker', displayName: 'worker' }
    ])

    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/web' }))).toBe('web')
    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/worker' }))).toBe(
      'worker'
    )
  })

  it('adds the minimal real parent suffix only for colliding basenames', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/platform/web', displayName: 'web' },
      { path: '/workspace/platform/payments/api', displayName: 'api' },
      { path: '/workspace/platform/billing/api', displayName: 'api' }
    ])

    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/web' }))).toBe('web')
    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/payments/api' }))).toBe(
      'payments/api'
    )
    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/billing/api' }))).toBe(
      'billing/api'
    )
  })

  it('expands colliding labels in lockstep without skipping shared segments', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/team1/shared/api', displayName: 'api' },
      { path: '/workspace/team2/shared/api', displayName: 'api' }
    ])

    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/team1/shared/api' }))).toBe(
      'team1/shared/api'
    )
    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/team2/shared/api' }))).toBe(
      'team2/shared/api'
    )
  })

  it('scopes labels by execution host so same-path repos on different hosts do not collide', () => {
    // Real SSH folder-repo shape: connectionId set, executionHostId unset — so
    // it must fall back to the connection host, not look identical to a local repo.
    const localRepo = { path: '/Users/alice', displayName: 'alice' }
    const sshRepo = { path: '/Users/alice', displayName: 'alice-prod', connectionId: 'prod-ssh' }
    const labels = getRepoDisplayLabelsByPath([localRepo, sshRepo])

    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBe('alice')
    expect(labels.get(getRepoDisplayLabelKey(sshRepo))).toBe('alice-prod')
    expect(labels.size).toBe(2)
  })

  it('keeps cross-host repos with identical path AND name as separate entries', () => {
    // Hardening: when paths are byte-identical the same-name collision loop runs
    // and re-sets each entry, so host scoping must survive that pass too — neither
    // host may overwrite the other, and the remote entry names its host because no
    // amount of parent segments can separate two copies of one path.
    const localRepo = { path: '/Users/alice', displayName: 'home' }
    const sshRepo = { path: '/Users/alice', displayName: 'home', connectionId: 'prod-ssh' }
    const labels = getRepoDisplayLabelsByPath([localRepo, sshRepo])

    expect(getRepoDisplayLabelKey(localRepo)).not.toBe(getRepoDisplayLabelKey(sshRepo))
    expect(labels.size).toBe(2)
    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBe('home')
    expect(labels.get(getRepoDisplayLabelKey(sshRepo))).toBe('home (prod-ssh)')
  })

  it('names the runtime host for a same-path collision without a connectionId', () => {
    const localRepo = { path: '/srv/app', displayName: 'app' }
    const runtimeRepo = {
      path: '/srv/app',
      displayName: 'app',
      connectionId: null,
      executionHostId: 'runtime:sandbox-1' as const
    }
    const labels = getRepoDisplayLabelsByPath([localRepo, runtimeRepo])

    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBe('app')
    expect(labels.get(getRepoDisplayLabelKey(runtimeRepo))).toBe('app (sandbox-1)')
  })

  it('renders the user-facing host name, not the generated host id', () => {
    // SshConnectionStore mints ids like this, so a bare getExecutionHostLabel
    // would put 'app (ssh-1754190000000-a1b2)' in front of the user.
    const localRepo = { path: '/Users/dev/app', displayName: 'app' }
    const sshRepo = {
      path: '/Users/dev/app',
      displayName: 'app',
      connectionId: 'ssh-1754190000000-a1b2'
    }
    const runtimeRepo = {
      path: '/Users/dev/app',
      displayName: 'app',
      executionHostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3' as const
    }
    const hostLabelById = new Map([
      ['ssh:ssh-1754190000000-a1b2', 'My Server'],
      ['runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3', 'dev box']
    ])
    const labels = getRepoDisplayLabelsByPath([localRepo, sshRepo, runtimeRepo], hostLabelById)

    expect(labels.get(getRepoDisplayLabelKey(sshRepo))).toBe('app (My Server)')
    expect(labels.get(getRepoDisplayLabelKey(runtimeRepo))).toBe('app (dev box)')
    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBe('app')
  })

  it('falls back to the raw host id when the lookup has no entry for it', () => {
    const localRepo = { path: '/srv/app', displayName: 'app' }
    const sshRepo = { path: '/srv/app', displayName: 'app', connectionId: 'prod-ssh' }
    const labels = getRepoDisplayLabelsByPath([localRepo, sshRepo], new Map())

    expect(labels.get(getRepoDisplayLabelKey(sshRepo))).toBe('app (prod-ssh)')
  })

  it('host-qualifies only the tied entries and keeps parent expansion minimal', () => {
    // The two /srv/app copies can only be split by host; the third sibling is
    // already unique at one parent segment, so it must not gain a host suffix or
    // get dragged out to its full path.
    const localRepo = { path: '/srv/app', displayName: 'app' }
    const sshRepo = { path: '/srv/app', displayName: 'app', connectionId: 'prod-ssh' }
    const otherRepo = { path: '/opt/vendor/app', displayName: 'app' }
    const labels = getRepoDisplayLabelsByPath([localRepo, sshRepo, otherRepo])

    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBe('srv/app')
    expect(labels.get(getRepoDisplayLabelKey(sshRepo))).toBe('srv/app (prod-ssh)')
    expect(labels.get(getRepoDisplayLabelKey(otherRepo))).toBe('vendor/app')
  })

  it('falls back to the path when a repo has no display name', () => {
    const named = { path: '/workspace/api', displayName: 'api' }
    const unnamed = { path: '/workspace/legacy', displayName: '' }
    const labels = getRepoDisplayLabelsByPath([named, unnamed])

    expect(labels.get(getRepoDisplayLabelKey(named))).toBe('api')
    expect(labels.get(getRepoDisplayLabelKey(unnamed))).toBe('/workspace/legacy')
  })

  it('normalizes Windows separators to slash display labels', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: 'C:\\workspace\\payments\\api', displayName: 'api' },
      { path: 'C:\\workspace\\billing\\api', displayName: 'api' }
    ])

    expect(labels.get(getRepoDisplayLabelKey({ path: 'C:\\workspace\\payments\\api' }))).toBe(
      'payments/api'
    )
    expect(labels.get(getRepoDisplayLabelKey({ path: 'C:\\workspace\\billing\\api' }))).toBe(
      'billing/api'
    )
  })
})
