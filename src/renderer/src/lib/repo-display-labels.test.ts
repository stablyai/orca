import { describe, expect, it } from 'vitest'
import { getRepoDisplayLabelsByPath } from './repo-display-labels'

describe('getRepoDisplayLabelsByPath', () => {
  it('keeps non-colliding repository names basename-only', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/platform/web', displayName: 'web' },
      { path: '/workspace/platform/worker', displayName: 'worker' }
    ])

    expect(labels.get('/workspace/platform/web')).toBe('web')
    expect(labels.get('/workspace/platform/worker')).toBe('worker')
  })

  it('adds the minimal real parent suffix only for colliding basenames', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/platform/web', displayName: 'web' },
      { path: '/workspace/platform/payments/api', displayName: 'api' },
      { path: '/workspace/platform/billing/api', displayName: 'api' }
    ])

    expect(labels.get('/workspace/platform/web')).toBe('web')
    expect(labels.get('/workspace/platform/payments/api')).toBe('payments/api')
    expect(labels.get('/workspace/platform/billing/api')).toBe('billing/api')
  })

  it('expands colliding labels in lockstep without skipping shared segments', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/team1/shared/api', displayName: 'api' },
      { path: '/workspace/team2/shared/api', displayName: 'api' }
    ])

    expect(labels.get('/workspace/team1/shared/api')).toBe('team1/shared/api')
    expect(labels.get('/workspace/team2/shared/api')).toBe('team2/shared/api')
  })

  it('normalizes Windows separators to slash display labels', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: 'C:\\workspace\\payments\\api', displayName: 'api' },
      { path: 'C:\\workspace\\billing\\api', displayName: 'api' }
    ])

    expect(labels.get('C:\\workspace\\payments\\api')).toBe('payments/api')
    expect(labels.get('C:\\workspace\\billing\\api')).toBe('billing/api')
  })
})
