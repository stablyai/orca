import { describe, expect, it } from 'vitest'
import {
  createDefaultWorkspaceCleanupBrowseState,
  normalizeWorkspaceCleanupBrowseState,
  WORKSPACE_CLEANUP_BROWSE_STATE_VERSION
} from './workspace-cleanup-browse-state'

/** orca-data.json is JSON, so anything that cannot survive this is not persistable. */
function throughDisk<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('workspace cleanup browse state persistence', () => {
  it('round-trips the default state unchanged', () => {
    const state = createDefaultWorkspaceCleanupBrowseState()
    expect(normalizeWorkspaceCleanupBrowseState(throughDisk(state))).toEqual(state)
  })

  it('round-trips an edited state', () => {
    const state = createDefaultWorkspaceCleanupBrowseState()
    state.filters.query = 'checkout'
    state.filters.activity = {
      idleSignal: 'created',
      idleMinDays: 45,
      neverVisited: true
    }
    state.filters.safety.blockers = ['dirty-files', 'pinned']
    state.filters.review = {
      presence: 'some',
      states: ['merged'],
      providers: ['gitlab']
    }
    state.sort = { field: 'size', direction: 'desc' }

    expect(normalizeWorkspaceCleanupBrowseState(throughDisk(state))).toEqual(state)
  })

  it('degrades a newer build’s state field by field instead of discarding it', () => {
    const persisted = {
      version: 99,
      activePresetId: 'suggested',
      unknownTopLevelField: { anything: true },
      filters: {
        query: 'keep me',
        activity: {
          idleSignal: 'from-the-future',
          idleMinDays: 30,
          unknownFacet: 'ignored'
        },
        safety: { tiers: ['ready', 'not-a-tier'] },
        unknownGroup: { enabled: true }
      },
      sort: { field: 'unknown-column', direction: 'desc' },
      customPresets: []
    }

    const normalized = normalizeWorkspaceCleanupBrowseState(persisted)

    expect(normalized.version).toBe(WORKSPACE_CLEANUP_BROWSE_STATE_VERSION)
    expect(normalized.filters.query).toBe('keep me')
    expect(normalized.filters.activity.idleMinDays).toBe(30)
    expect(normalized.filters.activity.idleSignal).toBe('last-visited')
    expect(normalized.filters.safety).toEqual(
      createDefaultWorkspaceCleanupBrowseState().filters.safety
    )
    expect(normalized.sort).toEqual({
      field: 'last-activity',
      direction: 'desc'
    })
    expect(normalized).not.toHaveProperty('activePresetId')
    expect(normalized).not.toHaveProperty('customPresets')
    expect(normalized).not.toHaveProperty('unknownTopLevelField')
  })

  it('drops invalid persisted host ids without losing valid SSH and runtime hosts', () => {
    const normalized = normalizeWorkspaceCleanupBrowseState({
      filters: {
        location: {
          hostIds: ['local', 'ssh:build%20box', 'not-a-host', 'runtime:linux', 'ssh:']
        }
      }
    })

    expect(normalized.filters.location.hostIds).toEqual([
      'local',
      'ssh:build%20box',
      'runtime:linux'
    ])
  })

  it.each([null, undefined, 'corrupt', 42, [], { filters: 'nonsense' }])(
    'never throws on a corrupt blob (%p)',
    (value) => {
      expect(normalizeWorkspaceCleanupBrowseState(value)).toEqual(
        createDefaultWorkspaceCleanupBrowseState()
      )
    }
  )
})
