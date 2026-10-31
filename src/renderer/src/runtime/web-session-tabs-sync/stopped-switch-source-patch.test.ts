import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import { buildMirroredStoppedSwitchSourcePatch } from './stopped-switch-source-patch'
import {
  ENV,
  LEAF_ID,
  NOW,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))

type Terminal = Extract<RuntimeMobileSessionTabsResult['tabs'][number], { type: 'terminal' }>
const fact = {
  ptyId: 'host-pty-1',
  incarnationId: 'incarnation-1',
  agent: 'codex',
  providerSessionId: 'codex-conversation'
} as const
const stopped: Terminal = {
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
const other: Terminal = {
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

it('keeps the held screen from the first frame when later frames carry the fact without it', () => {
  const screen = { data: 'HELD-FRAME', cols: 100, rows: 30 }
  const first = {
    ...makeState(),
    ...applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([{ ...stopped, stoppedSwitchSource: { ...fact, screen } }], {
        snapshotVersion: 1
      }),
      ENV,
      NOW
    )
  }
  const later = {
    ...first,
    ...applyWebSessionTabsSnapshot(
      first,
      makeSnapshot([{ ...stopped, title: 'Codex (stopped)' }], { snapshotVersion: 2 }),
      ENV,
      NOW
    )
  }
  expect(later.agentConversationsByPaneKey?.[paneKey]?.stoppedSwitchSource?.screen).toEqual(screen)
})

it('costs a frame nothing it can see when no fact changed, and sweeps retracted tabs in one pass', () => {
  const surfaces = (count: number, withStopped: boolean): Terminal[] => [
    ...(withStopped ? [stopped] : []),
    ...Array.from({ length: count }, (_, i) => ({
      ...other,
      id: `host-tab-${i + 2}::${LEAF_ID}`,
      parentTabId: `host-tab-${i + 2}`,
      terminal: `handle-${i + 2}`
    }))
  ]
  const held = {
    paneKey,
    worktreeId: 'wt-1',
    executionHostId: null,
    connectionId: null,
    agent: fact.agent,
    providerSession: { key: 'session_id' as const, id: fact.providerSessionId },
    stoppedSwitchSource: fact
  }
  // Every conversation the store holds, each read counted.
  let reads = 0
  const conversations: NonNullable<ReturnType<typeof makeState>['agentConversationsByPaneKey']> = {}
  for (let i = 0; i < 50; i += 1) {
    const key = i === 0 ? paneKey : `${toWebTerminalSurfaceTabId(`live-${i}`)}:${LEAF_ID}`
    const value = i === 0 ? held : { ...held, paneKey: key, stoppedSwitchSource: undefined }
    Object.defineProperty(conversations, key, {
      enumerable: true,
      get: () => {
        reads += 1
        return value
      }
    })
  }
  const state = makeState()
  for (const count of [50, 500]) {
    // No fact anywhere and none held for these panes: no store write.
    expect(
      buildMirroredStoppedSwitchSourcePatch(state, {}, surfaces(count, false), 'wt-1', [])
    ).toBeNull()
    // Main repeats the held fact on every frame: still no store write.
    expect(
      buildMirroredStoppedSwitchSourcePatch(state, conversations, surfaces(count, true), 'wt-1', [])
    ).toBeNull()
    // However many tabs retract, the held conversations are read once each.
    reads = 0
    const retractedTabIds = Array.from({ length: count }, (_, i) =>
      toWebTerminalSurfaceTabId(`gone-${i}`)
    )
    expect(
      buildMirroredStoppedSwitchSourcePatch(state, conversations, [], 'wt-1', retractedTabIds)
    ).toBeNull()
    expect(reads).toBe(50)
  }
})
