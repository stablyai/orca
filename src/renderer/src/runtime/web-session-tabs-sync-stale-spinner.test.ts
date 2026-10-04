import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resolveTerminalTabActivityStatus } from '../components/tab-bar/terminal-tab-activity-status'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import { toWebTerminalSurfaceTabId } from './web-runtime-session'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

const TAB_ID = toWebTerminalSurfaceTabId('host-tab-1')
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function hostPane(state: 'done' | 'working' = 'done'): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: HOST_SURFACE_ID,
    parentTabId: 'host-tab-1',
    leafId: LEAF_ID,
    title: state === 'done' ? 'Pi ready' : '⠋ Pi',
    launchAgent: 'pi',
    isActive: true,
    status: 'ready',
    terminal: 'terminal-1',
    agentStatus: {
      state,
      agentType: 'pi',
      paneKey: makePaneKey('host-tab-1', LEAF_ID),
      worktreeId: WT,
      prompt: '',
      updatedAt: state === 'working' ? NOW - 1_000 : NOW,
      stateStartedAt: state === 'working' ? NOW - 1_000 : NOW,
      stateHistory: []
    }
  }
}

function restoredState(): WebSessionTabsSyncState & {
  runtimePaneTitlesByTabId: NonNullable<WebSessionTabsSyncState['runtimePaneTitlesByTabId']>
} {
  const initial = makeState()
  const state = {
    ...initial,
    ...applyWebSessionTabsSnapshot(initial, makeSnapshot([hostPane('working')]), ENV, NOW)
  }
  const row = state.agentStatusByPaneKey[PANE_KEY]
  if (!row) {
    throw new Error('Missing mirrored status')
  }
  return {
    ...state,
    activeWorktreeId: 'another-workspace',
    runtimePaneTitlesByTabId: { [TAB_ID]: { 1: '⠋ Pi - saved session' } },
    agentStatusByPaneKey: {
      [PANE_KEY]: { ...row, mirroredEvidenceReceivedAt: NOW - 55 * 60 * 60 * 1000 }
    }
  }
}

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  resetRendererOwnedAgentStatusPanesForTests()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  resetRendererOwnedAgentStatusPanesForTests()
  vi.useRealTimers()
})

describe('remote completion repairs saved spinner titles', () => {
  it('refreshes numeric runtime slots in an inactive workspace and removes the false spinner', () => {
    const state = restoredState()
    const updated = {
      ...state,
      ...applyWebSessionTabsSnapshot(
        state,
        makeSnapshot([hostPane()], { snapshotVersion: 2 }),
        ENV,
        NOW
      )
    }
    expect(updated.runtimePaneTitlesByTabId[TAB_ID]).toEqual({ 1: 'Pi ready' })
    expect(state.runtimePaneTitlesByTabId[TAB_ID]).toEqual({ 1: '⠋ Pi - saved session' })
    expect(updated.agentStatusByPaneKey[PANE_KEY]?.state).toBe('done')
    const tab = updated.tabsByWorktree[WT]?.[0]
    if (!tab) {
      throw new Error('Missing mirrored tab')
    }
    expect(
      resolveTerminalTabActivityStatus({
        tab,
        runtimePaneTitlesByTabId: updated.runtimePaneTitlesByTabId,
        agentStatusByPaneKey: updated.agentStatusByPaneKey,
        agentStatusEpoch: updated.agentStatusEpoch,
        ptyIdsByTabId: updated.ptyIdsByTabId,
        terminalLayout: updated.terminalLayoutsByTabId[TAB_ID]
      })
    ).toBe('done')
  })

  it('drops orphan UUIDs and out-of-range slots without retaining their activity', () => {
    const state = restoredState()
    state.runtimePaneTitlesByTabId[TAB_ID] = { 2: '⠋ Pi', [SECOND_LEAF_ID]: '⠋ Pi' }
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane()], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId?.[TAB_ID]).toEqual({})
  })

  it('accepts host done over an expired row even when its clock is behind the client row', () => {
    const state = restoredState()
    const row = state.agentStatusByPaneKey[PANE_KEY]
    if (!row) {
      throw new Error('Missing mirrored status')
    }
    state.agentStatusByPaneKey[PANE_KEY] = { ...row, updatedAt: NOW + 60_000 }
    registerRendererOwnedAgentStatusPane(PANE_KEY, ENV)
    markRendererOwnedAgentStatusWrite(PANE_KEY)
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane()], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.agentStatusByPaneKey?.[PANE_KEY]).toMatchObject({ state: 'done', updatedAt: NOW })
    expect(patch.runtimePaneTitlesByTabId?.[TAB_ID]).toEqual({ 1: 'Pi ready' })
  })

  it('keeps a fresh byte-stream writer and its title during a lagging host publication', () => {
    const state = restoredState()
    const row = state.agentStatusByPaneKey[PANE_KEY]
    if (!row) {
      throw new Error('Missing mirrored status')
    }
    state.agentStatusByPaneKey[PANE_KEY] = { ...row, mirroredEvidenceReceivedAt: NOW }
    registerRendererOwnedAgentStatusPane(PANE_KEY, ENV)
    markRendererOwnedAgentStatusWrite(PANE_KEY)
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane()], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId).toBeUndefined()
    expect(patch.agentStatusByPaneKey?.[PANE_KEY]?.state ?? row.state).toBe('working')
  })

  it('preserves title repairs across a batched all-workspace inventory', () => {
    const state = restoredState()
    const patch = applyWebSessionTabsSnapshots(
      state,
      [
        makeSnapshot([hostPane()], { snapshotVersion: 2 }),
        makeSnapshot([], { worktree: 'another-workspace' })
      ],
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId?.[TAB_ID]).toEqual({ 1: 'Pi ready' })
    expect(patch.agentStatusByPaneKey?.[PANE_KEY]?.state).toBe('done')
  })

  it('keeps a genuinely working sibling spinning when another split pane completes', () => {
    const state = restoredState()
    const sibling = {
      ...hostPane('working'),
      id: `host-tab-1::${SECOND_LEAF_ID}`,
      leafId: SECOND_LEAF_ID,
      isActive: false,
      terminal: 'terminal-2'
    }
    state.runtimePaneTitlesByTabId[TAB_ID] = { 1: '⠋ Pi', 2: '⠋ Pi' }
    const updated = {
      ...state,
      ...applyWebSessionTabsSnapshot(
        state,
        makeSnapshot([hostPane(), sibling], { snapshotVersion: 2 }),
        ENV,
        NOW
      )
    }
    const tab = updated.tabsByWorktree[WT]?.[0]
    if (!tab) {
      throw new Error('Missing mirrored tab')
    }
    expect(updated.runtimePaneTitlesByTabId[TAB_ID]).toEqual({ 1: 'Pi ready', 2: '⠋ Pi' })
    expect(
      resolveTerminalTabActivityStatus({
        tab,
        agentStatusByPaneKey: updated.agentStatusByPaneKey,
        agentStatusEpoch: updated.agentStatusEpoch,
        runtimePaneTitlesByTabId: updated.runtimePaneTitlesByTabId,
        ptyIdsByTabId: updated.ptyIdsByTabId,
        terminalLayout: updated.terminalLayoutsByTabId[TAB_ID]
      })
    ).toBe('working')
  })

  it('does not interpret a pending host placeholder as new title evidence', () => {
    const state = restoredState()
    const pending = {
      ...hostPane(),
      title: 'Terminal',
      status: 'pending-handle' as const,
      agentStatus: undefined
    }
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([pending], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId).toBeUndefined()
  })

  it('does not rewrite local terminal runtime titles from a local session mirror', () => {
    const state = restoredState()
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane()], { snapshotVersion: 2 }),
      ENV,
      NOW,
      { terminalPtyMode: 'local' }
    )
    expect(patch.runtimePaneTitlesByTabId).toBeUndefined()
  })

  it('ignores orphan titles before host sync and falls back to the current tab title', () => {
    const state = restoredState()
    const tab = state.tabsByWorktree[WT]?.[0]
    if (!tab) {
      throw new Error('Missing mirrored tab')
    }
    expect(
      resolveTerminalTabActivityStatus({
        tab: { ...tab, title: 'Pi ready' },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 2: '⠋ Pi', [SECOND_LEAF_ID]: '⠋ Pi' } },
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayout: state.terminalLayoutsByTabId[TAB_ID]
      })
    ).toBe('active')
    expect(
      resolveTerminalTabActivityStatus({
        tab: { ...tab, title: '⠋ Pi' },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 2: 'Pi ready' } },
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayout: state.terminalLayoutsByTabId[TAB_ID]
      })
    ).toBe('working')
  })
})
