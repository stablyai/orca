import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from './types'
import { useAppStore } from './index'
import { makeTab } from './terminals/testing/terminal-tab.test-fixture'
import type { Tab } from '../../../shared/workspace-layout/tab-groups/tab-types'
import { shouldSyncAgentHookCompletionForStoreUpdate } from '@/components/terminal-pane/agent-completion/hook-lane/agent-hook-completion-store-sync'
import { whenAgentTerminalAppears } from '@/components/terminal-pane/provider-notices/agent-presence/agent-terminal-presence'
import { aiVaultTitleSyncInputsChanged } from '@/lib/agent-session/history/title-sync/ai-vault-tab-title-sync-inputs'
import { changedOwningPaneTitleRequests } from '@/lib/agent-session/history/title-sync/ai-vault-tab-title-freshness'
import { readRuntimeStatuses } from './slices/runtime-status/views/runtime-status-owner'
import { getRuntimeMobileSessionSyncKey } from '@/runtime/sync-runtime-graph/sync-key'
import { getTerminalTabOwners } from './terminals/ownership/terminal-tab-owner-index'
import { selectVisibleAgentOrchestration } from '@/runtime/agent-orchestration/visible-agent-orchestration'

// Perf contract (#44954, STA-16352): every terminal title change woke store subscribers that scanned every
// workspace's tab bucket, ~20 ms per title at 1,900 workspaces. A title change must read only its own
// tab's bucket: no whole-map enumeration and no other workspace's bucket, at N and at 10N.

afterEach(() => {
  vi.restoreAllMocks()
})

const objectReads = { keys: Object.keys, values: Object.values, entries: Object.entries }

type Reads = { count: number; measuring: boolean }

// Any field read on a row the title change did not replace is a scan of an unrelated workspace.
function counted<T extends { id: string }>(row: T, reads: Reads): T {
  const copy = { ...row }
  for (const key of objectReads.keys(row)) {
    const value: unknown = Object.getOwnPropertyDescriptor(row, key)?.value
    Object.defineProperty(copy, key, {
      enumerable: true,
      get() {
        if (reads.measuring) {
          reads.count += 1
        }
        return value
      }
    })
  }
  return copy
}

// Reading an unrelated bucket's element counts too, so even an identity compare of its row is caught.
function countedBucket<T extends { id: string }>(row: T, reads: Reads): T[] {
  const bucket: T[] = []
  const element = counted(row, reads)
  Object.defineProperty(bucket, '0', {
    enumerable: true,
    configurable: true,
    get() {
      if (reads.measuring) {
        reads.count += 1
      }
      return element
    }
  })
  return bucket
}

function unifiedTerminalTab(worktreeId: string, tabId: string): Tab {
  return {
    id: `unified-${tabId}`,
    entityId: tabId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function scannedRowsPerTitleChange(workspaceCount: number): number {
  const reads: Reads = { count: 0, measuring: false }
  const store = useAppStore
  const tabsByWorktree: AppState['tabsByWorktree'] = {}
  const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {}
  for (let index = 0; index < workspaceCount; index += 1) {
    const worktreeId = `wt-${index}`
    const tab = makeTab({ id: `tab-${index}`, worktreeId, createdAt: 0 })
    tabsByWorktree[worktreeId] = index === 0 ? [tab] : countedBucket(tab, reads)
    const unifiedTab = unifiedTerminalTab(worktreeId, tab.id)
    unifiedTabsByWorktree[worktreeId] =
      index === 0 ? [unifiedTab] : countedBucket(unifiedTab, reads)
  }
  // The app store is shared across populations, so every input this test writes starts fresh.
  store.setState({
    tabsByWorktree,
    unifiedTabsByWorktree,
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    activeWorktreeId: 'wt-0'
  })

  const records = (state: AppState): unknown[] => [
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    state.ptyIdsByTabId
  ]
  let watched = new Set<unknown>()
  const note = (value: unknown): void => {
    if (reads.measuring && watched.has(value)) {
      reads.count += 1
    }
  }
  vi.spyOn(Object, 'keys').mockImplementation((value) => {
    note(value)
    return objectReads.keys(value)
  })
  vi.spyOn(Object, 'values').mockImplementation((value) => {
    note(value)
    return objectReads.values(value)
  })
  vi.spyOn(Object, 'entries').mockImplementation((value) => {
    note(value)
    return objectReads.entries(value)
  })

  // The subscribers a title change reaches, in their store-subscription form, with their indexes warm.
  getTerminalTabOwners(store.getState().tabsByWorktree)
  let syncKey = getRuntimeMobileSessionSyncKey(store.getState())
  selectVisibleAgentOrchestration(store.getState())
  const stopMeasuring = store.subscribe((state, previous) => {
    watched = new Set([...records(state), ...records(previous)])
    reads.measuring = true
  })
  const stopPresence = whenAgentTerminalAppears('codex', () => {})
  const stopSubscribers = store.subscribe((state, previous) => {
    shouldSyncAgentHookCompletionForStoreUpdate(state, previous)
    changedOwningPaneTitleRequests(state, previous, readRuntimeStatuses())
    aiVaultTitleSyncInputsChanged(state, previous)
    syncKey = getRuntimeMobileSessionSyncKey(state, previous, syncKey)
    selectVisibleAgentOrchestration(state)
    reads.measuring = false
  })

  // One terminal title change, as pane title observation applies it.
  store.getState().setRuntimePaneTitle('tab-0', 1, 'build: step 2')
  store.getState().updateTabTitle('tab-0', 'build: step 2')
  expect(store.getState().runtimePaneTitlesByTabId['tab-0']?.[1]).toBe('build: step 2')
  expect(store.getState().tabsByWorktree['wt-0']?.[0]?.title).toBe('build: step 2')
  stopMeasuring()
  stopPresence()
  stopSubscribers()
  return reads.count
}

it('a terminal title change reads no other workspace, at N and 10N workspaces', () => {
  expect(scannedRowsPerTitleChange(200)).toBe(0)
  expect(scannedRowsPerTitleChange(2_000)).toBe(0)
})

function titleNotifications(apply: () => void): number {
  let notifications = 0
  const stop = useAppStore.subscribe(() => {
    notifications += 1
  })
  apply()
  stop()
  return notifications
}

it('a parked pane title that drives its tab notifies store subscribers once, and not at all when unchanged', () => {
  useAppStore.setState({
    tabsByWorktree: { 'wt-0': [makeTab({ id: 'tab-0', worktreeId: 'wt-0', createdAt: 0 })] },
    unifiedTabsByWorktree: { 'wt-0': [unifiedTerminalTab('wt-0', 'tab-0')] },
    runtimePaneTitlesByTabId: {},
    activeWorktreeId: 'wt-1'
  })
  const apply = (): void =>
    useAppStore.getState().setRuntimePaneTitle('tab-0', 1, '⠋ Codex', { alsoTabTitle: true })

  expect(titleNotifications(apply)).toBe(1)
  expect(useAppStore.getState().runtimePaneTitlesByTabId['tab-0']?.[1]).toBe('⠋ Codex')
  expect(useAppStore.getState().tabsByWorktree['wt-0']?.[0]?.title).toBe('⠋ Codex')
  expect(titleNotifications(apply)).toBe(0)
})
