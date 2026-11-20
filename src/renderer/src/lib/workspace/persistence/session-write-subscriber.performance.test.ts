import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import * as structuralEquality from '../../../../../shared/collections/structural-value-equality'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import { patchWorkspaceSessionByHost, type SessionApi } from './workspace-session-host-persistence'
import { patchWorkspaceSessionEntriesByHost } from './workspace-session-keyed-host-write'
import { sessionRoutingFor } from './workspace-session-host-routing'
import { makeOpenFile } from '@/store/slices/editor/types/open-file.test-fixture'
import { applyWorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'

// Perf contract (#45731): one background title change rebuilt and routed every workspace's saved tabs and layouts,
// so the write walked and deep-compared the whole fleet. Counts deep compares and keys routed to a host.

const DEBOUNCE_MS = 150
const OVER_CAP_TAB_IDS = new Set(['tab-0-b', 'tab-1-b'])

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// Main's local partition, rebuilt from each entries patch the way main applies it.
function receivingMain() {
  let stored: WorkspaceSessionState = getDefaultWorkspaceSession()
  let rejectNext = false
  const api: SessionApi = {
    get: async () => stored,
    patch: async () => {},
    patchEntries: async (patch) => {
      if (rejectNext) {
        rejectNext = false
        throw new Error('main rejected the save')
      }
      stored = { ...stored, ...applyWorkspaceSessionEntriesPatch(stored, patch) }
      return { status: 'applied' }
    }
  }
  return {
    api,
    stored: () => stored,
    rejectNextSave: () => {
      rejectNext = true
    }
  }
}

async function workForTitleChanges(size: number) {
  const store = createTestStore()
  const main = receivingMain()
  const sessionApi = main.api
  const acknowledged = new AcknowledgedWorkspaceSessionEntries()
  const stop = createSessionWriteSubscriber({
    store,
    debounceMs: DEBOUNCE_MS,
    persist: ({ patch, fields }) =>
      patchWorkspaceSessionByHost(sessionApi, patch, store.getState(), acknowledged, fields)
        .written,
    persistKeyed: (write) =>
      patchWorkspaceSessionEntriesByHost(sessionApi, write, store.getState(), acknowledged)
        ?.written ?? null
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
      // An editor shown in wt-2 for a file wt-1 owns: saves move it into wt-1.
      openFiles: [makeOpenFile({ id: 'file-of-wt-1', worktreeId: worktrees[1]!.id })],
      workspaceSessionReady: true,
      hydrationSucceeded: true
    })
    store.getState().createUnifiedTab(worktrees[2]!.id, 'editor', {
      id: 'editor-in-wt-2',
      entityId: 'file-of-wt-1',
      label: 'file.ts'
    })
    // The first save sends whole fields and main acknowledges them.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const deepCompares = vi.spyOn(structuralEquality, 'structuralValuesEqual')
    const routedKeys = vi.spyOn(sessionRoutingFor(store.getState()), 'hostIdByWorktreeId')
    store.getState().updateTabTitle('tab-3-b', 'Renamed by agent')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const work = {
      deepCompares: deepCompares.mock.calls.length,
      routedKeys: routedKeys.mock.calls.length
    }
    deepCompares.mockRestore()
    routedKeys.mockRestore()

    // A title in the workspace that receives the moved editor must keep that editor saved.
    store.getState().updateTabTitle('tab-1-a', 'Owner renamed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const ownerTabs = main.stored().unifiedTabs?.[worktrees[1]!.id]?.map((tab) => tab.label)
    // A rejected title save is still owed, and is sent with the next one.
    main.rejectNextSave()
    store.getState().updateTabTitle('tab-4-a', 'Rejected once')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    store.getState().updateTabTitle('tab-5-a', 'After the rejection')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const stored = main.stored()
    const titleOf = (index: number, tabId: string) =>
      stored.tabsByWorktree[worktrees[index]!.id]?.find((tab) => tab.id === tabId)?.title
    return {
      ...work,
      titles: [
        titleOf(3, 'tab-3-b'),
        titleOf(1, 'tab-1-a'),
        titleOf(4, 'tab-4-a'),
        titleOf(5, 'tab-5-a')
      ],
      ownerTabs
    }
  } finally {
    stop()
  }
}

it('a title change compares and routes only its workspace’s entries at N and 10N, and saves what the whole path saves', async () => {
  const expected = {
    deepCompares: 3,
    routedKeys: 5,
    titles: ['Renamed by agent', 'Owner renamed', 'Rejected once', 'After the rejection'],
    ownerTabs: ['Owner renamed', 'Terminal 2', 'file.ts']
  }
  expect(await workForTitleChanges(20)).toEqual(expected)
  expect(await workForTitleChanges(200)).toEqual(expected)
})
