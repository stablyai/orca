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

  it('disambiguates cross-host same-name projects with Local/SSH/Remote roles', () => {
    // Why: path-segment expansion cannot separate identical paths across hosts and
    // used to fall through to near-absolute path labels (#13221).
    const localRepo = { path: '/Users/me/workspace/foo', displayName: 'foo' }
    const runtimeRepo = {
      path: '/Users/me/workspace/foo',
      displayName: 'foo',
      executionHostId: 'runtime:env-1' as const
    }
    const labels = getRepoDisplayLabelsByPath([localRepo, runtimeRepo])

    expect(getRepoDisplayLabelKey(localRepo)).not.toBe(getRepoDisplayLabelKey(runtimeRepo))
    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBe('foo · Local')
    expect(labels.get(getRepoDisplayLabelKey(runtimeRepo))).toBe('foo · Remote')
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
