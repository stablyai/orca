import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../../shared/update-status-types'
import { createUISlice } from '../store/slices/ui/create-ui-slice'
import type { AppState } from '../store/types'
import { isUpdateCardVisible } from './maintenance/update-card/update-card-visibility'

function createTestStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    rightSidebarWidth: 280,
    ...createUISlice(...(args as Parameters<typeof createUISlice>))
  })) as unknown as StoreApi<AppState>
}

function setState(store: StoreApi<AppState>, status: UpdateStatus): void {
  store.getState().setUpdateStatus(status)
}

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      shell: { openUrl: vi.fn() },
      updater: {
        download: vi.fn().mockResolvedValue(undefined),
        quitAndInstall: vi.fn().mockResolvedValue(undefined),
        dismissNudge: vi.fn().mockResolvedValue(undefined),
        dismissAvailableUpdate: vi.fn().mockResolvedValue(undefined)
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

describe('updateCardCollapsed', () => {
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
})

// Exercise visibility gates without a full DOM so irrelevant cards stay hidden and real updates remain visible.

type VisibilityInput = {
  status: UpdateStatus
  dismissedVersion: string | null
  cachedVersion: string | null
  updateUserInitiatedCycle?: boolean
  collapsed?: boolean
}

type VisibilityResult = 'hidden' | 'visible'

function computeVisibility(input: VisibilityInput): VisibilityResult {
  return isUpdateCardVisible({
    ...input,
    updateUserInitiatedCycle: input.updateUserInitiatedCycle ?? false
  })
    ? 'visible'
    : 'hidden'
}

describe('UpdateCard visibility gates', () => {
  it('hides check errors once a new checking cycle cleared the cached version', () => {
    const store = createTestStore()
    setState(store, { state: 'available', version: '1.2.0', changelog: null })
    setState(store, { state: 'checking' })
    setState(store, { state: 'error', message: 'network timeout' })

    expect(
      computeVisibility({
        status: store.getState().updateStatus,
        collapsed: store.getState().updateCardCollapsed,
        dismissedVersion: '1.2.0',
        cachedVersion: null
      })
    ).toBe('hidden')
  })
})

describe('full update lifecycle through setUpdateStatus', () => {
  it('dismiss → new version cycle → card visible again', () => {
    const store = createTestStore()

    setState(store, { state: 'available', version: '1.2.0', changelog: null })
    store.getState().dismissUpdate()
    expect(store.getState().dismissedUpdateVersion).toBe('1.2.0')

    setState(store, { state: 'checking' })
    setState(store, { state: 'available', version: '1.3.0', changelog: null })

    expect(
      computeVisibility({
        status: store.getState().updateStatus,
        dismissedVersion: store.getState().dismissedUpdateVersion,
        cachedVersion: '1.3.0'
      })
    ).toBe('visible')
  })
})
