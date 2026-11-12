import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../../shared/runtime-mobile-session-tab-contracts'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { resolveTerminalTabActivityStatus } from '../../../components/tab-bar/terminal-tab-activity-status'
import { resetRendererOwnedAgentStatusPanesForTests } from '../../../components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'
import type { WebSessionTabsSyncState } from '../state'

import '../../hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
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
} from '../testing/web-session-tabs-sync.test-fixture'

vi.mock('../../../store/index', () => ({ useAppStore: { setState: vi.fn() } }))

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
  const row = state.agentStatusByPaneKey.get(PANE_KEY)
  if (!row) {
    throw new Error('Missing mirrored status')
  }
  return {
    ...state,
    activeWorktreeId: 'another-workspace',
    runtimePaneTitlesByTabId: { [TAB_ID]: { 1: '⠋ Pi - saved session' } },
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
        [PANE_KEY]: { ...row, mirroredEvidenceReceivedAt: NOW - 55 * 60 * 60 * 1000 }
      })
    )
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
    expect(updated.agentStatusByPaneKey.get(PANE_KEY)?.state).toBe('done')
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
})

it('keeps a received sleeping Done through a same-pane omission, then honors exact retraction', () => {
  const source = hostPane()
  source.agentStatus!.paneSleep = { ptyId: 'slept-pty', incarnationId: 'birth' }
  let state = makeState()
  state = { ...state, ...applyWebSessionTabsSnapshot(state, makeSnapshot([source]), ENV, NOW) }
  expect(state.agentStatusByPaneKey.get(PANE_KEY)).toMatchObject({
    state: 'done',
    paneSleep: { ptyId: 'slept-pty' }
  })
  const withoutStatus = { ...source, agentStatus: undefined }
  state = {
    ...state,
    ...applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([withoutStatus], { snapshotVersion: 2 }),
      ENV,
      NOW + 60 * 60 * 1000
    )
  }
  expect(state.agentStatusByPaneKey.get(PANE_KEY)).toMatchObject({
    state: 'done',
    paneSleep: { ptyId: 'slept-pty' }
  })
  state = {
    ...state,
    ...applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([], { snapshotVersion: 3 }),
      ENV,
      NOW + 60 * 60 * 1000
    )
  }
  expect(state.agentStatusByPaneKey.get(PANE_KEY)).toBeUndefined()
})
