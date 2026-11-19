import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import * as structuralEquality from '../../../../../shared/collections/structural-value-equality'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import { patchWorkspaceSessionByHost, type SessionApi } from './workspace-session-host-persistence'

// Perf contract: one background title change rebuilt every workspace's saved tabs and layouts with new
// identities, so the write deep-compared the whole fleet against what main held. Counts deep compares.

const DEBOUNCE_MS = 150
const OVER_CAP_TAB_IDS = new Set(['tab-0-b', 'tab-1-b'])

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const sessionApi: SessionApi = {
  get: async () => {
    throw new Error('not read in this flow')
  },
  patch: async () => {},
  patchEntries: async () => ({ status: 'applied' })
}

async function deepComparesForOneTitleChange(size: number): Promise<number> {
  const store = createTestStore()
  const acknowledged = new AcknowledgedWorkspaceSessionEntries()
  const stop = createSessionWriteSubscriber({
    store,
    debounceMs: DEBOUNCE_MS,
    persist: ({ patch }) =>
      patchWorkspaceSessionByHost(sessionApi, patch, store.getState(), acknowledged).written
  })
  try {
    const worktrees = Array.from({ length: size }, (_, index) =>
      makeWorktree({
        id: `${TEST_REPO.id}::/wt-${index}`,
        repoId: TEST_REPO.id,
        path: `/wt-${index}`
      })
    )
    seedStore(store, {
      worktreesByRepo: { [TEST_REPO.id]: worktrees },
      activeWorktreeId: worktrees[0]!.id
    })
    for (const [index, worktree] of worktrees.entries()) {
      store.getState().createTab(worktree.id, undefined, undefined, { id: `tab-${index}-a` })
      store.getState().createTab(worktree.id, undefined, undefined, { id: `tab-${index}-b` })
    }
    // Saved scrollback on every tab: a live local tab's copy is stripped on save, a dormant one's kept,
    // and two dormant tabs hold more than the session cap in both scrollback homes, so they are capped.
    const { tabsByWorktree, terminalLayoutsByTabId } = store.getState()
    const overCap = 'x'.repeat(600 * 1024)
    const scrollbackOf = (tabId: string) =>
      OVER_CAP_TAB_IDS.has(tabId) ? overCap : `scrollback of ${tabId}`
    store.setState({
      tabsByWorktree: Object.fromEntries(
        Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
          worktreeId,
          tabs.map((tab) => (tab.id.endsWith('-a') ? { ...tab, ptyId: `pty-${tab.id}` } : tab))
        ])
      ),
      terminalLayoutsByTabId: Object.fromEntries(
        Object.entries(terminalLayoutsByTabId).map(([tabId, layout]) => [
          tabId,
          { ...layout, buffersByLeafId: { 'leaf-1': scrollbackOf(tabId) } }
        ])
      ),
      localOnlyScrollbackByTabId: Object.fromEntries(
        [...OVER_CAP_TAB_IDS].map((tabId) => [tabId, { 'leaf-2': overCap }])
      ),
      workspaceSessionReady: true,
      hydrationSucceeded: true
    })
    // The first save sends whole fields and main acknowledges them.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const deepCompares = vi.spyOn(structuralEquality, 'structuralValuesEqual')
    store.getState().updateTabTitle('tab-3-b', 'Renamed by agent')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const count = deepCompares.mock.calls.length
    deepCompares.mockRestore()
    return count
  } finally {
    stop()
  }
}

it('one title change deep-compares only the retitled workspace’s entries at N and 10N', async () => {
  expect(await deepComparesForOneTitleChange(20)).toBe(4)
  expect(await deepComparesForOneTitleChange(200)).toBe(4)
})
