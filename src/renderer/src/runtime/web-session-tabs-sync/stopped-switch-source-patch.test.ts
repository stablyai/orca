import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import {
  ENV,
  LEAF_ID,
  NOW,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))

type Row = RuntimeMobileSessionTabsResult['tabs'][number]
const fact = {
  ptyId: 'host-pty-1',
  incarnationId: 'incarnation-1',
  agent: 'codex',
  providerSessionId: 'codex-conversation'
} as const
const stopped: Row = {
  type: 'terminal',
  id: `host-tab-1::${LEAF_ID}`,
  parentTabId: 'host-tab-1',
  leafId: LEAF_ID,
  title: 'Codex',
  isActive: true,
  status: 'ready',
  terminal: 'handle-1',
  incarnationId: fact.incarnationId,
  stoppedSwitchSource: fact
}
const other: Row = {
  ...stopped,
  id: `host-tab-2::${LEAF_ID}`,
  parentTabId: 'host-tab-2',
  terminal: 'handle-2',
  stoppedSwitchSource: undefined
}
const paneKey = `${toWebTerminalSurfaceTabId('host-tab-1')}:${LEAF_ID}`

beforeEach(resetWebSessionTabsSyncTestState)

it('carries main’s fact into the pane’s conversation through every frame, until the tab closes', () => {
  const shown = {
    ...makeState(),
    ...applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([stopped], { snapshotVersion: 1 }),
      ENV,
      NOW
    )
  }
  expect(shown.agentConversationsByPaneKey?.[paneKey]).toMatchObject({
    agent: 'codex',
    providerSession: { id: 'codex-conversation' },
    stoppedSwitchSource: fact
  })
  // The pane keeps the stopped process's binding: its screen stays and nothing reattaches.
  expect(Object.values(shown.terminalLayoutsByTabId)[0]?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
    `remote:${ENV}@@handle-1`
  )
  const closed = applyWebSessionTabsSnapshot(
    shown,
    makeSnapshot([other], { snapshotVersion: 2 }),
    ENV,
    NOW
  )
  expect(closed.agentConversationsByPaneKey).toBeDefined()
  expect({ ...shown, ...closed }.agentConversationsByPaneKey?.[paneKey]).toBeUndefined()
})
