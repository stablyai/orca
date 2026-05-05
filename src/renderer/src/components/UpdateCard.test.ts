/* eslint-disable max-lines -- Why: the update-card behavior is easiest to verify as one
   lifecycle-oriented suite because the store caching and visibility rules interact directly. */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../shared/constants'
import type { ChangelogData, UpdateStatus } from '../../../shared/types'
import { createUISlice } from '../store/slices/ui'
import type { AppState } from '../store/types'

// ── Helpers ──────────────────────────────────────────────────────────

function createTestStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    rightSidebarWidth: 280,
    ...createUISlice(...(args as Parameters<typeof createUISlice>))
  })) as unknown as StoreApi<AppState>
}

const RICH_CHANGELOG: ChangelogData = {
  release: {
    title: 'Inline Diffs',
    description: 'Review diffs without leaving the terminal.',
    mediaUrl: 'https://onorca.dev/media/inline-diffs.png',
    releaseNotesUrl: 'https://onorca.dev/changelog/1.2.0'
  },
  releasesBehind: 3
}

function setState(store: StoreApi<AppState>, status: UpdateStatus): void {
  store.getState().setUpdateStatus(status)
}

// ── Store-level tests for setUpdateStatus / changelog caching ────────

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      shell: { openUrl: vi.fn() },
      updater: {
        download: vi.fn().mockResolvedValue(undefined),
        quitAndInstall: vi.fn().mockResolvedValue(undefined),
        dismissNudge: vi.fn().mockResolvedValue(undefined)
      }
    },
    matchMedia: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setUpdateStatus changelog caching', () => {
  it('caches changelog from the available status', () => {
    const store = createTestStore()
    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })

    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)
  })

  it('preserves cached changelog through downloading → downloaded → error transitions', () => {
    const store = createTestStore()
    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })

    setState(store, { state: 'downloading', percent: 50, version: '1.2.0' })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    setState(store, { state: 'downloaded', version: '1.2.0' })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    setState(store, { state: 'error', message: 'write failed' })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)
  })

  it('clears cached changelog on cycle-boundary states (idle, checking, not-available)', () => {
    const store = createTestStore()
    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    setState(store, { state: 'idle' })
    expect(store.getState().updateChangelog).toBeNull()

    // Re-seed and test checking
    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })
    setState(store, { state: 'checking' })
    expect(store.getState().updateChangelog).toBeNull()

    // Re-seed and test not-available
    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })
    setState(store, { state: 'not-available' })
    expect(store.getState().updateChangelog).toBeNull()
  })

  it('overwrites previous rich changelog with null when new available has no changelog', () => {
    const store = createTestStore()
    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    // New update cycle with no changelog data
    setState(store, { state: 'available', version: '1.3.0', changelog: null })
    expect(store.getState().updateChangelog).toBeNull()
  })
})

// ── dismissUpdate ────────────────────────────────────────────────────

describe('dismissUpdate', () => {
  it('dismisses the version from current available status', () => {
    const store = createTestStore()
    setState(store, { state: 'available', version: '1.2.0', changelog: null })

    store.getState().dismissUpdate()

    expect(store.getState().dismissedUpdateVersion).toBe('1.2.0')
    expect(window.api.ui.set).toHaveBeenCalledWith({ dismissedUpdateVersion: '1.2.0' })
  })

  it('uses versionOverride when the current status has no version field (error state)', () => {
    const store = createTestStore()
    setState(store, { state: 'error', message: 'boom' })

    store.getState().dismissUpdate('1.2.0')

    expect(store.getState().dismissedUpdateVersion).toBe('1.2.0')
  })

  it('sets null when error state and no override is provided', () => {
    const store = createTestStore()
    setState(store, { state: 'error', message: 'boom' })

    store.getState().dismissUpdate()

    expect(store.getState().dismissedUpdateVersion).toBeNull()
  })
})

// ── dismissUpdate nudge-aware path ───────────────────────────────────

describe('dismissUpdate nudge-aware', () => {
  it('calls dismissNudge when the current status has an activeNudgeId', () => {
    const store = createTestStore()
    setState(store, {
      state: 'available',
      version: '1.2.0',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })

    store.getState().dismissUpdate()

    expect(store.getState().dismissedUpdateVersion).toBe('1.2.0')
    expect(window.api.updater.dismissNudge).toHaveBeenCalledTimes(1)
  })

  it('does not call dismissNudge when the status has no activeNudgeId', () => {
    const store = createTestStore()
    setState(store, { state: 'available', version: '1.2.0', changelog: null })

    store.getState().dismissUpdate()

    expect(store.getState().dismissedUpdateVersion).toBe('1.2.0')
    expect(window.api.updater.dismissNudge).not.toHaveBeenCalled()
  })

  it('calls dismissNudge when dismissing during a nudge-driven download', () => {
    const store = createTestStore()
    setState(store, {
      state: 'downloading',
      percent: 50,
      version: '1.2.0',
      activeNudgeId: 'campaign-1'
    })

    store.getState().dismissUpdate()

    expect(window.api.updater.dismissNudge).toHaveBeenCalledTimes(1)
  })
})

// ── updateCardCollapsed ──────────────────────────────────────────────

describe('updateCardCollapsed', () => {
  it('defaults to false', () => {
    const store = createTestStore()
    expect(store.getState().updateCardCollapsed).toBe(false)
  })

  it('setUpdateCardCollapsed toggles the flag without persisting', () => {
    const store = createTestStore()

    store.getState().setUpdateCardCollapsed(true)
    expect(store.getState().updateCardCollapsed).toBe(true)
    expect(window.api.ui.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ updateCardCollapsed: expect.anything() })
    )

    store.getState().setUpdateCardCollapsed(false)
    expect(store.getState().updateCardCollapsed).toBe(false)
  })

  it('resets to false on every state transition so new phases re-surface', () => {
    const store = createTestStore()

    setState(store, { state: 'downloading', percent: 20, version: '1.2.0' })
    store.getState().setUpdateCardCollapsed(true)
    expect(store.getState().updateCardCollapsed).toBe(true)

    // Why: percent-only updates are not transitions and must not reset.
    setState(store, { state: 'downloading', percent: 50, version: '1.2.0' })
    expect(store.getState().updateCardCollapsed).toBe(true)

    setState(store, { state: 'downloaded', version: '1.2.0' })
    expect(store.getState().updateCardCollapsed).toBe(false)
  })

  it('re-surfaces the card when downloading transitions to error', () => {
    const store = createTestStore()

    setState(store, { state: 'downloading', percent: 80, version: '1.2.0' })
    store.getState().setUpdateCardCollapsed(true)

    setState(store, { state: 'error', message: 'ENOSPC' })
    expect(store.getState().updateCardCollapsed).toBe(false)
  })
})

// ── markUpdateReassuranceSeen ────────────────────────────────────────

describe('markUpdateReassuranceSeen', () => {
  it('persists reassurance-seen flag to disk', () => {
    const store = createTestStore()
    expect(store.getState().updateReassuranceSeen).toBe(false)

    store.getState().markUpdateReassuranceSeen()

    expect(store.getState().updateReassuranceSeen).toBe(true)
    expect(window.api.ui.set).toHaveBeenCalledWith({ updateReassuranceSeen: true })
  })
})

// ── hydratePersistedUI for update fields ─────────────────────────────

describe('hydratePersistedUI update fields', () => {
  it('restores dismissedUpdateVersion from persisted UI', () => {
    const store = createTestStore()

    store.getState().hydratePersistedUI({
      ...getDefaultUIState(),
      dismissedUpdateVersion: '1.1.0'
    })

    expect(store.getState().dismissedUpdateVersion).toBe('1.1.0')
  })

  it('restores updateReassuranceSeen from persisted UI', () => {
    const store = createTestStore()

    store.getState().hydratePersistedUI({
      ...getDefaultUIState(),
      updateReassuranceSeen: true
    })

    expect(store.getState().updateReassuranceSeen).toBe(true)
  })

  it('defaults updateReassuranceSeen to false when absent from persisted UI', () => {
    const store = createTestStore()

    store.getState().hydratePersistedUI({
      ...getDefaultUIState(),
      updateReassuranceSeen: undefined as unknown as boolean
    })

    expect(store.getState().updateReassuranceSeen).toBe(false)
  })
})

// ── Visibility gate logic (pure function extraction) ─────────────────
// Why: the UpdateCard component's render gates are the most critical
// correctness surface — a wrong gate means users either miss updates or
// get spammed with irrelevant cards. We test the gate logic as a pure
// function to avoid needing a full React/DOM environment.

type VisibilityInput = {
  status: UpdateStatus
  dismissedVersion: string | null
  cachedVersion: string | null
  hasStartedDownload: boolean
}

type VisibilityResult = 'hidden' | 'visible'

/** Mirrors the visibility gates in UpdateCard's render path. */
function computeVisibility(input: VisibilityInput): VisibilityResult {
  const { status, dismissedVersion, cachedVersion, hasStartedDownload } = input
  const isUserInitiated = 'userInitiated' in status && status.userInitiated
  const shouldShowDetailedErrorCard =
    status.state === 'error' && (hasStartedDownload || cachedVersion !== null)

  if (status.state === 'checking' && !isUserInitiated) {
    return 'hidden'
  }
  if (status.state === 'not-available' && !isUserInitiated) {
    return 'hidden'
  }
  if (status.state === 'idle') {
    return 'hidden'
  }
  if (status.state === 'error' && !shouldShowDetailedErrorCard && !isUserInitiated) {
    return 'hidden'
  }

  const effectiveVersion = 'version' in status ? status.version : cachedVersion
  if (effectiveVersion && dismissedVersion === effectiveVersion) {
    if (status.state !== 'downloading' && status.state !== 'error') {
      return 'hidden'
    }
  }

  return 'visible'
}

describe('UpdateCard visibility gates', () => {
  it('hides on idle', () => {
    expect(
      computeVisibility({
        status: { state: 'idle' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('hides background checking (not user-initiated)', () => {
    expect(
      computeVisibility({
        status: { state: 'checking' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows user-initiated checking', () => {
    expect(
      computeVisibility({
        status: { state: 'checking', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides background not-available', () => {
    expect(
      computeVisibility({
        status: { state: 'not-available' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows user-initiated not-available (before auto-dismiss)', () => {
    expect(
      computeVisibility({
        status: { state: 'not-available', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows available update (simple mode)', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.2.0', changelog: null },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows available update (rich mode)', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides available when version is dismissed', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.2.0', changelog: null },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows downloading even when version is dismissed (user clicked Update after dismiss)', () => {
    expect(
      computeVisibility({
        status: { state: 'downloading', percent: 42, version: '1.2.0' },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: true
      })
    ).toBe('visible')
  })

  it('hides downloaded when version is dismissed (Settings-initiated, not card)', () => {
    expect(
      computeVisibility({
        status: { state: 'downloaded', version: '1.2.0' },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('hides background errors silently', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'network' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows user-initiated check errors', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'network', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows card-initiated download errors', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'ENOSPC' },
        dismissedVersion: null,
        cachedVersion: '1.2.0',
        hasStartedDownload: true
      })
    ).toBe('visible')
  })

  it('shows settings-initiated download errors when a version is cached', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'ENOSPC' },
        dismissedVersion: null,
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows downloaded for card-initiated downloads', () => {
    expect(
      computeVisibility({
        status: { state: 'downloaded', version: '1.2.0' },
        dismissedVersion: null,
        cachedVersion: '1.2.0',
        hasStartedDownload: true
      })
    ).toBe('visible')
  })

  it('re-shows card for a newer version even if an older version was dismissed', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.3.0', changelog: null },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.3.0',
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows error for dismissed version when an active update action fails', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'fail', userInitiated: true },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides check errors once a new checking cycle cleared the cached version', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'network timeout' },
        dismissedVersion: '1.2.0',
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })
})

// ── Full update lifecycle through the store ──────────────────────────

describe('full update lifecycle through setUpdateStatus', () => {
  it('walks through available → downloading → downloaded preserving changelog', () => {
    const store = createTestStore()

    setState(store, { state: 'checking', userInitiated: true })
    expect(store.getState().updateStatus.state).toBe('checking')
    expect(store.getState().updateChangelog).toBeNull()

    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })
    expect(store.getState().updateStatus.state).toBe('available')
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    setState(store, { state: 'downloading', percent: 0, version: '1.2.0' })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    setState(store, { state: 'downloading', percent: 100, version: '1.2.0' })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    setState(store, { state: 'downloaded', version: '1.2.0' })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)
  })

  it('clears stale changelog when a new check cycle starts', () => {
    const store = createTestStore()

    // First update cycle — rich
    setState(store, { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    // Download fails, error preserves changelog
    setState(store, { state: 'error', message: 'ENOSPC' })
    expect(store.getState().updateChangelog).toEqual(RICH_CHANGELOG)

    // New check cycle starts — changelog must be cleared so it doesn't
    // leak into a different version's card.
    setState(store, { state: 'checking' })
    expect(store.getState().updateChangelog).toBeNull()

    // New version available without changelog
    setState(store, { state: 'available', version: '1.3.0', changelog: null })
    expect(store.getState().updateChangelog).toBeNull()
  })

  it('dismiss → new version cycle → card visible again', () => {
    const store = createTestStore()

    setState(store, { state: 'available', version: '1.2.0', changelog: null })
    store.getState().dismissUpdate()
    expect(store.getState().dismissedUpdateVersion).toBe('1.2.0')

    // Simulate a new check cycle finding a newer version
    setState(store, { state: 'checking' })
    setState(store, { state: 'available', version: '1.3.0', changelog: null })

    // The dismissed version is 1.2.0 but the available version is 1.3.0 — card should show
    expect(
      computeVisibility({
        status: store.getState().updateStatus,
        dismissedVersion: store.getState().dismissedUpdateVersion,
        cachedVersion: '1.3.0',
        hasStartedDownload: false
      })
    ).toBe('visible')
  })
})
