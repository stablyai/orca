import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RepoRuntimeOwnerState } from './repo-runtime-owner'
import {
  getExplicitRuntimeOwnerEnvironmentId,
  getRepoOwnerRoutedSettings,
  getRuntimeEnvironmentIdForRepo,
  getSettingsForRepoRuntimeOwner,
  releaseRepoRuntimeOwnerSettingsCache
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

describe('getSettingsForRepoRuntimeOwner identity', () => {
  beforeEach(() => {
    releaseRepoRuntimeOwnerSettingsCache()
  })

  type OwnerRepo = NonNullable<RepoRuntimeOwnerState['repos']>[number]
  const repos: OwnerRepo[] = [
    { id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-a' }
  ]
  const settings = {
    activeRuntimeEnvironmentId: 'focused',
    sourceControlViewMode: 'list'
  } as unknown as GlobalSettings

  // Why identity matters: these run inside useShallow selectors, so a fresh
  // object per store write costs a full settings-wide compare on every row.
  it('returns the same reference while settings and repos are unchanged', () => {
    const state = { repos, settings }
    expect(getSettingsForRepoRuntimeOwner(state, 'repo-1')).toBe(
      getSettingsForRepoRuntimeOwner(state, 'repo-1')
    )
  })

  it('keeps separate identities per repo id', () => {
    const state = { repos, settings }
    const first = getSettingsForRepoRuntimeOwner(state, 'repo-1')
    const second = getSettingsForRepoRuntimeOwner(state, 'repo-2')
    expect(first).not.toBe(second)
    expect(first.activeRuntimeEnvironmentId).toBe('env-a')
    expect(second.activeRuntimeEnvironmentId).toBe('focused')
    // Interleaving must not evict either entry.
    expect(getSettingsForRepoRuntimeOwner(state, 'repo-1')).toBe(first)
    expect(getSettingsForRepoRuntimeOwner(state, 'repo-2')).toBe(second)
  })

  it('returns a new value when the settings object changes', () => {
    const first = getSettingsForRepoRuntimeOwner({ repos, settings }, 'repo-1')
    const nextSettings = { ...settings, sourceControlViewMode: 'tree' } as unknown as GlobalSettings
    const second = getSettingsForRepoRuntimeOwner({ repos, settings: nextSettings }, 'repo-1')
    expect(second).not.toBe(first)
    expect((second as { sourceControlViewMode?: string }).sourceControlViewMode).toBe('tree')
  })

  it('returns a new value when the repo owner changes', () => {
    const first = getSettingsForRepoRuntimeOwner({ repos, settings }, 'repo-1')
    const movedRepos: OwnerRepo[] = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-b' }
    ]
    const second = getSettingsForRepoRuntimeOwner({ repos: movedRepos, settings }, 'repo-1')
    expect(second).not.toBe(first)
    expect(second.activeRuntimeEnvironmentId).toBe('env-b')
  })

  // Why isolate each source: a fixture that changes the repo list AND the
  // resolved owner together still passes when only one of the two checks
  // survives, so each gets a case that holds the other constant.
  it('returns a new value when the repo list changes but the owner does not', () => {
    const first = getSettingsForRepoRuntimeOwner({ repos, settings }, 'repo-1')
    // Same owner for repo-1; only the array identity and an unrelated row differ.
    const grownRepos: OwnerRepo[] = [
      ...repos,
      { id: 'repo-9', connectionId: null, executionHostId: 'local' }
    ]
    const second = getSettingsForRepoRuntimeOwner({ repos: grownRepos, settings }, 'repo-1')
    expect(second.activeRuntimeEnvironmentId).toBe('env-a')
    expect(second).not.toBe(first)
  })

  it('returns a new value when the owner changes under a stable repo list identity', () => {
    // Mutate in place so the array reference and settings both stay identical
    // and only the resolved environment id differs.
    const mutableRepos: OwnerRepo[] = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-a' }
    ]
    const state = { repos: mutableRepos, settings }
    const first = getSettingsForRepoRuntimeOwner(state, 'repo-1')
    expect(first.activeRuntimeEnvironmentId).toBe('env-a')
    mutableRepos[0]!.executionHostId = 'runtime:env-c'
    const second = getSettingsForRepoRuntimeOwner(state, 'repo-1')
    expect(second.activeRuntimeEnvironmentId).toBe('env-c')
    expect(second).not.toBe(first)
  })

  it('bounds the cache so unbounded repo ids cannot leak', () => {
    const state = { repos, settings }
    const first = getSettingsForRepoRuntimeOwner(state, 'repo-evictable')
    for (let index = 0; index < 300; index += 1) {
      getSettingsForRepoRuntimeOwner(state, `repo-filler-${index}`)
    }
    expect(getSettingsForRepoRuntimeOwner(state, 'repo-evictable')).not.toBe(first)
  })
})
