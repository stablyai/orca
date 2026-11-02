import { describe, expect, it } from 'vitest'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

function persistedWithIdleDays(idleMinDays: number | null) {
  const browse = createDefaultWorkspaceCleanupBrowseState()
  browse.filters.activity.idleMinDays = idleMinDays
  return makePersistedUI({ workspaceCleanup: { dismissals: {}, browse } })
}

describe('workspace cleanup browse hydration', () => {
  it('restores persisted filters on startup', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(persistedWithIdleDays(30), 'startup')

    expect(store.getState().workspaceCleanupBrowse.filters.activity.idleMinDays).toBe(30)
  })

  it('does not let a sync broadcast revert a filter the user just set', () => {
    // Other ui.set broadcasts carry stale browse state until its debounced writer runs.
    const store = createUIStore()
    store.getState().hydratePersistedUI(persistedWithIdleDays(30), 'startup')

    const edited = createDefaultWorkspaceCleanupBrowseState()
    edited.filters.activity.idleMinDays = 45
    store.setState({ workspaceCleanupBrowse: edited })

    store.getState().hydratePersistedUI(persistedWithIdleDays(30), 'sync')

    expect(store.getState().workspaceCleanupBrowse.filters.activity.idleMinDays).toBe(45)
  })

  it('does not let a sync broadcast revert a typed query', () => {
    const store = createUIStore()
    const edited = createDefaultWorkspaceCleanupBrowseState()
    edited.filters.query = 'release'
    store.setState({ workspaceCleanupBrowse: edited })

    store.getState().hydratePersistedUI(persistedWithIdleDays(null), 'sync')

    expect(store.getState().workspaceCleanupBrowse.filters.query).toBe('release')
  })

  it('defaults an absent source to sync, so an unlabelled broadcast cannot revert either', () => {
    const store = createUIStore()
    const edited = createDefaultWorkspaceCleanupBrowseState()
    edited.filters.activity.idleMinDays = 45
    store.setState({ workspaceCleanupBrowse: edited })

    store.getState().hydratePersistedUI(persistedWithIdleDays(30))

    expect(store.getState().workspaceCleanupBrowse.filters.activity.idleMinDays).toBe(45)
  })

  it('still hydrates dismissals on sync, which are main-owned and not edited here', () => {
    const store = createUIStore()
    const dismissal = {
      worktreeId: 'repo-1::/repo/one',
      dismissedAt: Date.now(),
      fingerprint: 'fp-1',
      classifierVersion: 2
    }

    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceCleanup: {
          dismissals: { [dismissal.worktreeId]: dismissal },
          browse: createDefaultWorkspaceCleanupBrowseState()
        }
      }),
      'sync'
    )

    expect(store.getState().workspaceCleanupDismissals[dismissal.worktreeId]).toBeDefined()
  })
})
