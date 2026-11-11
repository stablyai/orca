import { beforeEach, expect, it } from 'vitest'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import { recordReceivedWebSessionTabsSnapshot } from './tracking'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import {
  ENV,
  WT,
  LEAF_ID,
  NOW,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './testing/web-session-tabs-sync.test-fixture'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../shared/runtime-mobile-session-tab-contracts'

beforeEach(resetWebSessionTabsSyncTestState)
it('publishes the qualified hold with a mirrored unbound pane and clears it on an authoritative binding', () => {
  const row: RuntimeMobileSessionTerminalClientTab = {
    type: 'terminal',
    id: `host-tab-1::${LEAF_ID}`,
    parentTabId: 'host-tab-1',
    leafId: LEAF_ID,
    title: 'Terminal',
    isActive: false,
    status: 'pending-handle',
    terminal: null,
    retainedTerminalStart: {
      worktreeId: WT,
      runtimeId: 'runtime-1',
      executionHostId: 'local',
      tabId: 'host-tab-1',
      leafId: LEAF_ID,
      bindingGeneration: 0,
      startSequence: 2,
      status: 'failed',
      reason: 'The shell could not start.'
    }
  }
  const state = makeState()
  const snapshot = makeSnapshot([row])
  const receivedFrame = recordReceivedWebSessionTabsSnapshot(ENV, snapshot, undefined, 'runtime-1')
  const recovered = { ...snapshot, tabs: [{ ...row, retainedTerminalStart: undefined }] }
  decideWebSessionTabsSnapshot(recovered, ENV, 'runtime-1', receivedFrame, snapshot)
  const patch = applyWebSessionTabsSnapshot(state, recovered, ENV, NOW)
  const projected = { ...state, ...patch }
  expect(projected.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['web-terminal-host-tab-1'])
  expect(projected.terminalPaneStartsByPaneKey[`web-terminal-host-tab-1:${LEAF_ID}`]).toMatchObject(
    { status: 'failed' }
  )
  expect(projected.terminalPaneStartsByPaneKey[`host-tab-1:${LEAF_ID}`]).toBeUndefined()
  const ready: RuntimeMobileSessionTerminalClientTab = {
    ...row,
    status: 'ready',
    terminal: 'term-new',
    ptyId: 'pty-new',
    retainedTerminalStart: undefined
  }
  const readySnapshot = makeSnapshot([ready], { snapshotVersion: 2 })
  const readyFrame = recordReceivedWebSessionTabsSnapshot(
    ENV,
    readySnapshot,
    undefined,
    'runtime-1'
  )
  decideWebSessionTabsSnapshot(readySnapshot, ENV, 'runtime-1', readyFrame)
  const bound = applyWebSessionTabsSnapshot(projected, readySnapshot, ENV, NOW)
  expect(
    { ...projected, ...bound }.terminalPaneStartsByPaneKey[`web-terminal-host-tab-1:${LEAF_ID}`]
  ).toBeUndefined()
})
