import { describe, expect, it } from 'vitest'
import type { RepoRuntimeOwnerState } from './repo-runtime-owner'
import {
  getExplicitRuntimeOwnerEnvironmentId,
  getRuntimeEnvironmentIdForRepo,
  runtimeTargetForRepoOwner
} from './repo-runtime-owner'

describe('getRuntimeEnvironmentIdForRepo', () => {
  it('uses an explicit runtime repo owner instead of the focused runtime', () => {
    expect(
      getRuntimeEnvironmentIdForRepo(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }]
        },
        'repo-1'
      )
    ).toBe('owner-runtime')
  })

  it('keeps explicit local repos local while a runtime is focused', () => {
    expect(
      getRuntimeEnvironmentIdForRepo(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }]
        },
        'repo-1'
      )
    ).toBeNull()
  })

  it('keeps SSH-owned repos on local IPC while a runtime is focused', () => {
    expect(
      getRuntimeEnvironmentIdForRepo(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: 'ssh-1', executionHostId: null }]
        },
        'repo-1'
      )
    ).toBeNull()
  })

  it('keeps legacy repos without an owner local while a runtime is focused', () => {
    expect(
      getRuntimeEnvironmentIdForRepo(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: null }]
        },
        'repo-1'
      )
    ).toBeNull()
  })
})

type OwnerRow = NonNullable<RepoRuntimeOwnerState['repos']>[number]
const row = (
  executionHostId: OwnerRow['executionHostId'],
  connectionId: string | null = null
): OwnerRow => ({
  id: 'repo-1',
  connectionId,
  executionHostId
})

// Composer passes a singleton or empty list; automations pass the whole catalog.
describe('getRuntimeEnvironmentIdForRepo owner matrix', () => {
  it.each<[string, OwnerRow[], string | null, string | null]>([
    ['local row', [row('local')], 'focused', null],
    ['direct SSH row', [row(null, 'ssh-1')], 'focused', null],
    ['nested runtime row', [row('runtime:owner', 'ssh-1')], 'focused', 'owner'],
    ['unstamped row', [row(null)], 'focused', null],
    ['missing row', [], 'focused', 'focused'],
    ['duplicates, local focus', [row('local'), row('runtime:owner')], null, null],
    ['duplicates, matching focus', [row('local'), row('runtime:owner')], 'owner', null],
    ['duplicates, other focus', [row('local'), row('runtime:owner')], 'other', null],
    ['duplicates, deleted focus', [row('runtime:a'), row('runtime:b')], 'deleted', null]
  ])('%s', (_name, repos, focused, expected) => {
    const settings = { activeRuntimeEnvironmentId: focused }
    expect(getRuntimeEnvironmentIdForRepo({ repos, settings }, 'repo-1')).toBe(expected)
  })
})

describe('getExplicitRuntimeOwnerEnvironmentId', () => {
  it('returns the runtime env id for a repo with an explicit runtime owner', () => {
    expect(
      getExplicitRuntimeOwnerEnvironmentId(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }]
        },
        'repo-1'
      )
    ).toBe('owner-runtime')
  })

  it('returns null for an explicit local owner even while a runtime is focused', () => {
    expect(
      getExplicitRuntimeOwnerEnvironmentId(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }]
        },
        'repo-1'
      )
    ).toBeNull()
  })

  it('returns null for an SSH-owned repo (connectionId only)', () => {
    expect(
      getExplicitRuntimeOwnerEnvironmentId(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: 'ssh-1', executionHostId: null }]
        },
        'repo-1'
      )
    ).toBeNull()
  })

  // Why: unlike getRuntimeEnvironmentIdForRepo, a no-owner repo must NOT fall
  // back to the focused runtime — an owner-less repo is a local repo (#6957).
  it('returns null for a legacy repo without an owner instead of the focused runtime', () => {
    expect(
      getExplicitRuntimeOwnerEnvironmentId(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: null }]
        },
        'repo-1'
      )
    ).toBeNull()
  })

  it('routes duplicate repo ids to the runtime row that focus selects unambiguously', () => {
    expect(
      getExplicitRuntimeOwnerEnvironmentId(
        {
          settings: { activeRuntimeEnvironmentId: 'owner-runtime' },
          repos: [
            { id: 'repo-1', connectionId: null, executionHostId: 'local' },
            { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
          ]
        },
        'repo-1'
      )
    ).toBe('owner-runtime')
  })

  it('returns null for ambiguous duplicate repo ids when focus matches no row', () => {
    expect(
      getExplicitRuntimeOwnerEnvironmentId(
        {
          settings: { activeRuntimeEnvironmentId: 'other-runtime' },
          repos: [
            { id: 'repo-1', connectionId: null, executionHostId: 'local' },
            { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
          ]
        },
        'repo-1'
      )
    ).toBeNull()
  })

  it('returns null when the repo id is missing', () => {
    expect(
      getExplicitRuntimeOwnerEnvironmentId(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }]
        },
        null
      )
    ).toBeNull()
  })
})

describe('runtimeTargetForRepoOwner', () => {
  const focused = { activeRuntimeEnvironmentId: 'focused-runtime' }

  it('routes by the row, never by the focused server', () => {
    expect(
      runtimeTargetForRepoOwner(
        {
          settings: focused,
          repos: [{ id: 'r', connectionId: null, executionHostId: 'runtime:owner' }]
        },
        'r'
      )
    ).toEqual({ kind: 'environment', environmentId: 'owner' })
    expect(
      runtimeTargetForRepoOwner(
        { settings: focused, repos: [{ id: 'r', connectionId: 'box', executionHostId: null }] },
        'r'
      )
    ).toEqual({ kind: 'local' })
  })

  it('treats a row with no owner stamp as local instead of the focused server (#6957)', () => {
    expect(
      runtimeTargetForRepoOwner(
        { settings: focused, repos: [{ id: 'r', connectionId: null, executionHostId: null }] },
        'r'
      )
    ).toEqual({ kind: 'local' })
  })

  it('refuses a twin rather than taking the focused copy', () => {
    const repos = [
      { id: 'r', connectionId: null, executionHostId: 'local' as const },
      { id: 'r', connectionId: null, executionHostId: 'runtime:owner' as const }
    ]
    expect(runtimeTargetForRepoOwner({ settings: focused, repos }, 'r')).toBeNull()
    expect(
      runtimeTargetForRepoOwner({ settings: { activeRuntimeEnvironmentId: 'owner' }, repos }, 'r')
    ).toBeNull()
    expect(
      runtimeTargetForRepoOwner({ settings: { activeRuntimeEnvironmentId: null }, repos }, 'r')
    ).toBeNull()
  })

  it('has no transport for an unknown repo', () => {
    expect(runtimeTargetForRepoOwner({ settings: focused, repos: [] }, 'r')).toBeNull()
    expect(runtimeTargetForRepoOwner({ settings: focused, repos: [] }, null)).toBeNull()
  })
})
