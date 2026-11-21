import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import * as structuralEquality from '../../../../../shared/collections/structural-value-equality'
import * as launchPersistence from '../../agent-session/launch/structured-agent-session-launch-persistence'
import * as fileHostOwnership from '@/lib/workspace/ownership/unified-tab-host-ownership'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import type { SessionApi } from './workspace-session-host-persistence'
import { subscribeWorkspaceSessionHostWrites } from './workspace-session-host-write-subscriber'
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
  const stop = subscribeWorkspaceSessionHostWrites({
    store,
    api: sessionApi,
    acknowledged,
    debounceMs: DEBOUNCE_MS
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

    // Editing replaces the open-file list but moves no editor tab.
    store.setState((state) => ({
      openFiles: state.openFiles.map((file) => ({ ...file, language: 'markdown' }))
    }))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const deepCompares = vi.spyOn(structuralEquality, 'structuralValuesEqual')
    const routedKeys = vi.spyOn(sessionRoutingFor(store.getState()), 'hostIdByWorktreeId')
    const slotSignatureBuilds = vi.spyOn(launchPersistence, 'structuredLaunchSlotSignatures')
    const hostUnions = vi.spyOn(acknowledged, 'settledHosts')
    store.getState().updateTabTitle('tab-3-b', 'Renamed by agent')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    // Read now: the whole retry after the rejection below would rewrite it either way.
    const measuredTitle = main
      .stored()
      .tabsByWorktree[worktrees[3]!.id]?.find((tab) => tab.id === 'tab-3-b')?.title
    const counts = {
      deepCompares: deepCompares.mock.calls.length,
      routedKeys: routedKeys.mock.calls.length,
      slotSignatureBuilds: slotSignatureBuilds.mock.calls.length,
      hostUnions: hostUnions.mock.calls.length
    }
    hostUnions.mockRestore()
    deepCompares.mockRestore()
    routedKeys.mockRestore()
    slotSignatureBuilds.mockRestore()

    // The open files were proven placement-equal by that save: the next title skips the proof.
    const placementChecks = vi.spyOn(fileHostOwnership, 'getOpenFileExecutionHostId')
    store.getState().updateTabTitle('tab-7-b', 'Second title')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const repeatedPlacementChecks = placementChecks.mock.calls.length
    placementChecks.mockRestore()

    // Saves that fall back to the whole path read launch slots once, not once per attempt.
    const fallbackSlotBuilds = vi.spyOn(launchPersistence, 'structuredLaunchSlotSignatures')
    // The moved editor's file now opens over SSH: its saved tab in wt-1 must follow, even when the
    // next title change is in a workspace that holds neither end of the move.
    store.setState((state) => ({
      openFiles: state.openFiles.map((file) => ({ ...file, externalSshTargetId: 'target-1' }))
    }))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    store.getState().updateTabTitle('tab-6-a', 'Third workspace')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const movedEditorHost = main
      .stored()
      .unifiedTabs?.[worktrees[1]!.id]?.find((tab) => tab.id === 'editor-in-wt-2')?.executionHostId
    // A title in the workspace that receives the moved editor must keep that editor saved.
    store.getState().updateTabTitle('tab-1-a', 'Owner renamed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const ownerUnifiedTabs = main.stored().unifiedTabs?.[worktrees[1]!.id]
    const ownerTabs = ownerUnifiedTabs?.map((tab) => tab.entityId)
    const ownerLabel = ownerUnifiedTabs?.find((tab) => tab.entityId === 'tab-1-a')?.label
    // A rejected title save is still owed, and is sent with the next one.
    main.rejectNextSave()
    store.getState().updateTabTitle('tab-4-a', 'Rejected once')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    store.getState().updateTabTitle('tab-5-a', 'After the rejection')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const fallbackSlotReads = fallbackSlotBuilds.mock.calls.length
    fallbackSlotBuilds.mockRestore()
    const stored = main.stored()
    const titleOf = (index: number, tabId: string) =>
      stored.tabsByWorktree[worktrees[index]!.id]?.find((tab) => tab.id === tabId)?.title
    return {
      ...counts,
      repeatedPlacementChecks,
      titles: [measuredTitle, titleOf(1, 'tab-1-a'), titleOf(4, 'tab-4-a'), titleOf(5, 'tab-5-a')],
      ownerTabs,
      ownerLabel,
      movedEditorHost,
      fallbackSlotReads
    }
  } finally {
    stop()
  }
}

it('a title change compares and routes only its workspace’s entries at N and 10N, and saves what the whole path saves', async () => {
  const expected = {
    deepCompares: 3,
    routedKeys: 5,
    slotSignatureBuilds: 1,
    hostUnions: 1,
    repeatedPlacementChecks: 0,
    titles: ['Renamed by agent', 'Owner renamed', 'Rejected once', 'After the rejection'],
    ownerTabs: ['tab-1-a', 'tab-1-b', 'file-of-wt-1'],
    ownerLabel: 'Owner renamed',
    movedEditorHost: 'ssh:target-1',
    fallbackSlotReads: 4
  }
  expect(await workForTitleChanges(20)).toEqual(expected)
  expect(await workForTitleChanges(200)).toEqual(expected)
})
