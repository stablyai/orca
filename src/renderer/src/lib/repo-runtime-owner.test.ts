import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../shared/types'
import {
  getExplicitRuntimeOwnerEnvironmentId,
  getRepoOwnerRoutedSettings,
  getRuntimeEnvironmentIdForRepo,
  getSettingsForRepoRuntimeOwner
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

  it('falls back to the focused runtime for legacy repos without an owner', () => {
    expect(
      getRuntimeEnvironmentIdForRepo(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: null }]
        },
        'repo-1'
      )
    ).toBe('focused-runtime')
  })

  it('uses the focused host row when duplicate repo ids exist', () => {
    expect(
      getRuntimeEnvironmentIdForRepo(
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

  it('does not silently choose a duplicate repo row when the focused host does not match', () => {
    expect(
      getRuntimeEnvironmentIdForRepo(
        {
          settings: { activeRuntimeEnvironmentId: 'other-runtime' },
          repos: [
            { id: 'repo-1', connectionId: null, executionHostId: 'local' },
            { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
          ]
        },
        'repo-1'
      )
    ).toBe('other-runtime')
  })

  it('returns settings scoped to an explicit local repo owner', () => {
    expect(
      getSettingsForRepoRuntimeOwner(
        {
          settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
          repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }]
        },
        'repo-1'
      )
    ).toEqual({ activeRuntimeEnvironmentId: null })
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

describe('getRepoOwnerRoutedSettings', () => {
  // Why: SourceControl builds its git/file mutation contexts from this value,
  // so it must rebind activeRuntimeEnvironmentId to the repo OWNER even while a
  // different host is focused — otherwise stage/commit/push hit the wrong host.
  it('routes a git mutation context for a runtime-owned active repo to the owner, not the focused runtime', () => {
    const settings = {
      activeRuntimeEnvironmentId: 'focused-runtime',
      sourceControlViewMode: 'list'
    } as unknown as GlobalSettings

    const routed = getRepoOwnerRoutedSettings(settings, {
      id: 'repo-1',
      connectionId: null,
      executionHostId: 'runtime:owner-runtime'
    })

    expect(routed?.activeRuntimeEnvironmentId).toBe('owner-runtime')
    // Non-routing (display) fields must survive the rebind untouched.
    expect((routed as { sourceControlViewMode?: string }).sourceControlViewMode).toBe('list')
  })

  it('falls back to the focused runtime for a legacy repo without an explicit owner', () => {
    const settings = { activeRuntimeEnvironmentId: 'focused-runtime' } as unknown as GlobalSettings
    const routed = getRepoOwnerRoutedSettings(settings, {
      id: 'repo-1',
      connectionId: null,
      executionHostId: null
    })
    expect(routed?.activeRuntimeEnvironmentId).toBe('focused-runtime')
  })

  it('passes null settings through unchanged', () => {
    expect(
      getRepoOwnerRoutedSettings(null, {
        id: 'repo-1',
        connectionId: null,
        executionHostId: null
      })
    ).toBeNull()
  })
})
