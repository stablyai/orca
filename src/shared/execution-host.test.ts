import { describe, expect, it } from 'vitest'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  normalizeExecutionHostOrder,
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'

describe('execution host identity', () => {
  it('normalizes local, SSH, and runtime host ids', () => {
    expect(parseExecutionHostId('local')).toEqual({ kind: 'local', id: 'local' })
    expect(parseExecutionHostId(toSshExecutionHostId('win vm'))).toEqual({
      kind: 'ssh',
      id: 'ssh:win%20vm',
      targetId: 'win vm'
    })
    expect(parseExecutionHostId(toRuntimeExecutionHostId('prod/server'))).toEqual({
      kind: 'runtime',
      id: 'runtime:prod%2Fserver',
      environmentId: 'prod/server'
    })
  })

  it('falls back invalid scopes to all hosts', () => {
    expect(normalizeExecutionHostScope(null)).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(normalizeExecutionHostScope('')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(normalizeExecutionHostScope('bogus')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(normalizeExecutionHostScope('ssh:')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(normalizeExecutionHostScope('all')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
  })

  it('normalizes visible host id arrays', () => {
    expect(normalizeVisibleExecutionHostIds(null)).toBeNull()
    expect(normalizeVisibleExecutionHostIds([])).toBeNull()
    expect(normalizeVisibleExecutionHostIds(['local', 'bogus', 'ssh:win%20vm', 'local'])).toEqual([
      'local',
      'ssh:win%20vm'
    ])
  })

  it('normalizes host order arrays', () => {
    expect(normalizeExecutionHostOrder(null)).toEqual([])
    expect(normalizeExecutionHostOrder([])).toEqual([])
    expect(normalizeExecutionHostOrder(['ssh:win%20vm', 'bogus', 'local', 'ssh:win%20vm'])).toEqual(
      ['ssh:win%20vm', 'local']
    )
  })

  it('derives repo ownership from SSH connection ids', () => {
    expect(getRepoExecutionHostId({ connectionId: null })).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(getRepoExecutionHostId({ connectionId: 'ssh-target-1' })).toBe('ssh:ssh-target-1')
  })

  it('derives focused host compatibility from active runtime settings', () => {
    expect(getSettingsFocusedExecutionHostId(null)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(getSettingsFocusedExecutionHostId({ activeRuntimeEnvironmentId: 'runtime-1' })).toBe(
      'runtime:runtime-1'
    )
  })
})
