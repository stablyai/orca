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
    // host may overwrite the other. Label text can still coincide; that residual is
    // disambiguated by the host section/badge, not this map.
    const localRepo = { path: '/Users/alice', displayName: 'home' }
    const sshRepo = { path: '/Users/alice', displayName: 'home', connectionId: 'prod-ssh' }
    const labels = getRepoDisplayLabelsByPath([localRepo, sshRepo])

    expect(getRepoDisplayLabelKey(localRepo)).not.toBe(getRepoDisplayLabelKey(sshRepo))
    expect(labels.size).toBe(2)
    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBeDefined()
    expect(labels.get(getRepoDisplayLabelKey(sshRepo))).toBeDefined()
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
