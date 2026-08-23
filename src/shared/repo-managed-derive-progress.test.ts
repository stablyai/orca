import { describe, expect, it } from 'vitest'
import {
  REPO_MANAGED_DERIVE_PHASES,
  repoManagedDeriveProgress
} from './repo-managed-derive-progress'

describe('repoManagedDeriveProgress', () => {
  it('maps each derive phase to a determinate percent', () => {
    expect(REPO_MANAGED_DERIVE_PHASES).toEqual(['preparing', 'init', 'seed', 'sync', 'register'])
    expect(repoManagedDeriveProgress('preparing')).toEqual({
      phase: 'preparing',
      step: 1,
      total: 5,
      percent: 20
    })
    expect(repoManagedDeriveProgress('init')).toEqual({
      phase: 'init',
      step: 2,
      total: 5,
      percent: 40
    })
    expect(repoManagedDeriveProgress('seed')).toEqual({
      phase: 'seed',
      step: 3,
      total: 5,
      percent: 60
    })
    expect(repoManagedDeriveProgress('sync')).toEqual({
      phase: 'sync',
      step: 4,
      total: 5,
      percent: 80
    })
    expect(repoManagedDeriveProgress('register')).toEqual({
      phase: 'register',
      step: 5,
      total: 5,
      percent: 100
    })
  })
})
