import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { resetRendererOwnedAgentStatusPanesForTests } from '../../../components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'

import '../../hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
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
