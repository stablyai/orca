import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resolveTerminalTabActivityStatus } from '../components/tab-bar/terminal-tab-activity-status'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots
} from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { registerRuntimeTerminalTab } from './mounted-terminal-tab-registry'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

const TAB_ID = toWebTerminalSurfaceTabId('host-tab-1')
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function hostPane(state: 'done' | 'working' = 'done'): RuntimeMobileSessionTerminalClientTab & {
  status: 'ready'
  terminal: string
} {
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

  it('drops absent durable leaves while refreshing a sparse numeric slot', () => {
    const state = restoredState()
    const orphanTitles = { 2: '⠋ Pi', [SECOND_LEAF_ID]: '⠋ Pi' }
    state.runtimePaneTitlesByTabId[TAB_ID] = orphanTitles
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane()], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId?.[TAB_ID]).toEqual({ 2: 'Pi ready' })
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
    state.agentStatusByPaneKey[PANE_KEY] = {
      ...row,
      updatedAt: NOW,
      mirroredEvidenceReceivedAt: undefined
    }
    registerRendererOwnedAgentStatusPane(PANE_KEY, ENV)
    markRendererOwnedAgentStatusWrite(PANE_KEY)
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane()], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId).toBeUndefined()
    const nextStatuses = patch.agentStatusByPaneKey ?? state.agentStatusByPaneKey
    expect(nextStatuses[PANE_KEY]?.state).toBe('working')
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

  it('refreshes sparse runtime slots through their retained PTY bindings after a pane closes', () => {
    const sibling = {
      ...hostPane('working'),
      id: `host-tab-1::${SECOND_LEAF_ID}`,
      leafId: SECOND_LEAF_ID,
      isActive: false,
      terminal: 'terminal-2'
    }
    const initial = makeState()
    const state = {
      ...initial,
      ...applyWebSessionTabsSnapshot(
        initial,
        makeSnapshot([hostPane('working'), sibling]),
        ENV,
        NOW
      ),
      runtimePaneTitlesByTabId: { [TAB_ID]: { 1: '⠋ Pi - first', 3: '⠋ Pi - sibling' } }
    }
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane(), sibling], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId?.[TAB_ID]).toEqual({ 1: 'Pi ready', 3: '⠋ Pi' })
  })

  it.each([false, true])(
    'keeps moved pane titles attached to their PTY with a fresh writer: %s',
    (freshFirstWriter) => {
      const sibling = {
        ...hostPane(),
        id: `host-tab-1::${SECOND_LEAF_ID}`,
        leafId: SECOND_LEAF_ID,
        isActive: false,
        terminal: 'terminal-2',
        title: 'Pi second ready'
      }
      const initial = makeState()
      const mirrored = {
        ...initial,
        ...applyWebSessionTabsSnapshot(
          initial,
          makeSnapshot([hostPane('working'), sibling]),
          ENV,
          NOW
        )
      }
      const layout: TerminalLayoutSnapshot = {
        ...mirrored.terminalLayoutsByTabId[TAB_ID],
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: SECOND_LEAF_ID },
          second: { type: 'leaf', leafId: LEAF_ID }
        }
      }
      const state = {
        ...mirrored,
        terminalLayoutsByTabId: { [TAB_ID]: layout },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: '⠋ Pi - first', 2: '⠋ Pi - second' } }
      }
      if (freshFirstWriter) {
        const row = state.agentStatusByPaneKey[PANE_KEY]
        if (!row) {
          throw new Error('Missing mirrored status')
        }
        state.agentStatusByPaneKey[PANE_KEY] = {
          ...row,
          mirroredEvidenceReceivedAt: undefined
        }
        registerRendererOwnedAgentStatusPane(PANE_KEY, ENV)
        markRendererOwnedAgentStatusWrite(PANE_KEY)
      }
      const patch = applyWebSessionTabsSnapshot(
        state,
        makeSnapshot([hostPane(), sibling], { snapshotVersion: 2 }),
        ENV,
        NOW
      )
      expect(patch.runtimePaneTitlesByTabId?.[TAB_ID]).toEqual({
        1: freshFirstWriter ? '⠋ Pi - first' : 'Pi ready',
        2: 'Pi second ready'
      })
    }
  )

  it('retains an unmapped numeric title until its pane ownership is known', () => {
    const state = restoredState()
    state.runtimePaneTitlesByTabId[TAB_ID] = { 3: '⠋ Pi', 7: '⠋ Pi' }
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([hostPane()], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
    expect(patch.runtimePaneTitlesByTabId).toBeUndefined()
    expect(state.runtimePaneTitlesByTabId[TAB_ID]).toEqual({ 3: '⠋ Pi', 7: '⠋ Pi' })
  })

  it('keeps titles of a client split the pre-split host snapshot does not have yet', () => {
    const leafIdsBySlot = new Map([
      [1, LEAF_ID],
      [2, THIRD_LEAF_ID]
    ])
    const manager = {
      getLeafId: (paneId: number) => leafIdsBySlot.get(paneId) ?? null,
      getNumericIdForLeaf: (leafId: string) =>
        [...leafIdsBySlot].find(([, id]) => id === leafId)?.[0] ?? null
    }
    const unregister = registerRuntimeTerminalTab({
      tabId: TAB_ID,
      worktreeId: WT,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the title patch reads only getLeafId/getNumericIdForLeaf.
      getManager: () => manager as unknown as PaneManager,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    try {
      const state = restoredState()
      const clientSplitTitles = {
        1: '⠋ Pi - saved session',
        2: '⠋ Pi',
        [THIRD_LEAF_ID]: '⠋ Pi'
      }
      state.runtimePaneTitlesByTabId[TAB_ID] = clientSplitTitles
      const patch = applyWebSessionTabsSnapshot(
        state,
        makeSnapshot([hostPane()], { snapshotVersion: 2 }),
        ENV,
        NOW
      )
      expect(patch.runtimePaneTitlesByTabId?.[TAB_ID]).toEqual({
        1: 'Pi ready',
        2: '⠋ Pi',
        [THIRD_LEAF_ID]: '⠋ Pi'
      })
    } finally {
      unregister()
    }
  })

  it('does not interpret a pending host placeholder as new title evidence', () => {
    const state = restoredState()
    const pending = {
      ...hostPane(),
      title: 'Terminal',
      status: 'pending-handle' as const,
      terminal: null,
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
    const orphanTitles = { [SECOND_LEAF_ID]: '⠋ Pi' }
    const readyOrphanTitles = { [SECOND_LEAF_ID]: 'Pi ready' }
    expect(
      resolveTerminalTabActivityStatus({
        tab: { ...tab, title: 'Pi ready' },
        runtimePaneTitlesByTabId: { [TAB_ID]: orphanTitles },
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayout: state.terminalLayoutsByTabId[TAB_ID]
      })
    ).toBe('active')
    expect(
      resolveTerminalTabActivityStatus({
        tab: { ...tab, title: '⠋ Pi' },
        runtimePaneTitlesByTabId: { [TAB_ID]: readyOrphanTitles },
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayout: state.terminalLayoutsByTabId[TAB_ID]
      })
    ).toBe('working')
  })
})
