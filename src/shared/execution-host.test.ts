import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  normalizeExecutionHostOrder,
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'

describe('execution host identity', () => {
  // Why: the navigator cases below replace globalThis.navigator; restore it after
  // each test so the stub can't bleed into the rest of the suite.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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

  it('labels the local host by platform and by navigator detection', () => {
    expect(getLocalExecutionHostLabel('darwin')).toBe('Local Mac')
    expect(getLocalExecutionHostLabel('win32')).toBe('Local Windows')
    expect(getLocalExecutionHostLabel('linux')).toBe('Local Linux')
    expect(getLocalExecutionHostLabel('freebsd')).toBe('This computer')

    // With no explicit platform, the label is derived from navigator.userAgent
    // (the path the live host-selector dialog uses).
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(getLocalExecutionHostLabel()).toBe('Local Windows')

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(getLocalExecutionHostLabel()).toBe('Local Linux')

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(getLocalExecutionHostLabel()).toBe('Local Mac')

    // Non-matching userAgent falls through to process.platform; compare against the
    // explicit-platform label so the assertion is deterministic on any CI OS.
    vi.stubGlobal('navigator', { userAgent: 'totally-unknown-agent' })
    expect(getLocalExecutionHostLabel()).toBe(getLocalExecutionHostLabel(process.platform))
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

  it('prefers explicit worktree ownership before repo and focused-host fallbacks', () => {
    expect(
      getWorktreeExecutionHostId(
        { hostId: 'runtime:workspace-owner' },
        { connectionId: 'repo-owner' },
        'runtime:focused-host'
      )
    ).toBe('runtime:workspace-owner')
    expect(
      getWorktreeExecutionHostId({}, { connectionId: 'repo-owner' }, 'runtime:focused-host')
    ).toBe('ssh:repo-owner')
    expect(getWorktreeExecutionHostId({}, {}, 'runtime:focused-host')).toBe('runtime:focused-host')
  })

  it('derives focused host compatibility from active runtime settings', () => {
    expect(getSettingsFocusedExecutionHostId(null)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(getSettingsFocusedExecutionHostId({ activeRuntimeEnvironmentId: 'runtime-1' })).toBe(
      'runtime:runtime-1'
    )
  })
})
