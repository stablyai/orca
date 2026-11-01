import { beforeEach, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import {
  makeState,
  LEAF_ID,
  SECOND_LEAF_ID,
  NOW,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import { collectCollidingRetractionPaneKeys } from './retraction-pane-ownership'
import { buildRetractedMirroredTabSweepPatch } from './agent-status-primitives'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import {
  getForegroundTerminalTabLastSeenAtById,
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from '../../lib/foreground-terminal-tabs'

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  resetForegroundTerminalTabIdsForTests()
})

it.each([true, false])('cleans unrelated tabs when a collision is mirrored=%s', (mirrored) => {
  const collision = mirrored ? toWebTerminalSurfaceTabId('collision') : 'local-tab'
  const ordinary = toWebTerminalSurfaceTabId('ordinary')
  const owned = makePaneKey(collision, LEAF_ID)
  const foreign = makePaneKey(collision, SECOND_LEAF_ID)
  const normal = makePaneKey(ordinary, LEAF_ID)
  const conversations: WebSessionTabsSyncState['agentConversationsByPaneKey'] = {
    [owned]: {
      paneKey: owned,
      worktreeId: 'folder:own',
      executionHostId: 'local',
      connectionId: 'host-a',
      agent: 'codex',
      providerSession: { key: 'session_id', id: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60' }
    }
  }
  const state = makeState({
    agentConversationsByPaneKey: conversations,
    acknowledgedAgentsByPaneKey: { [foreign]: 2 },
    agentStatusByPaneKey: Object.fromEntries(
      [owned, normal].map((paneKey) => [
        paneKey,
        {
          paneKey,
          worktreeId: 'folder:own',
          connectionId: 'host-a',
          agentType: 'omp' as const,
          state: 'working' as const,
          prompt: '',
          updatedAt: NOW,
          stateStartedAt: NOW,
          stateHistory: []
        }
      ])
    )
  })
  setForegroundTerminalTabIds([collision, ordinary])
  try {
    const scope = collectCollidingRetractionPaneKeys(
      state,
      [collision, ordinary],
      'host-a',
      'folder:own'
    )
    const patch = buildRetractedMirroredTabSweepPatch(state, {}, null, [collision, ordinary], scope)
    const after = { ...state, ...patch }
    expect(after.agentConversationsByPaneKey).toBe(conversations)
    expect(patch).not.toHaveProperty('agentConversationsByPaneKey')
    expect(after.acknowledgedAgentsByPaneKey?.[foreign]).toBe(2)
    expect(after.agentStatusByPaneKey[normal]).toBeUndefined()
    expect(after.recentlyClosedAgentStatusTabIds?.[ordinary]).toBeDefined()
    expect(after.recentlyClosedAgentStatusTabIds?.[collision]).toBeUndefined()
    expect(getForegroundTerminalTabLastSeenAtById()[ordinary]).toBeUndefined()
    expect(getForegroundTerminalTabLastSeenAtById()[collision]).toBeDefined()
  } finally {
    resetForegroundTerminalTabIdsForTests()
  }
})

it('indexes unchanged auxiliary records once per batch and refreshes replacements', () => {
  let enumerations = 0
  const record: Record<string, number> = {}
  const tabs = Array.from({ length: 100 }, (_, index) => toWebTerminalSurfaceTabId(`host-${index}`))
  for (const tab of tabs) {
    record[makePaneKey(tab, LEAF_ID)] = 1
  }
  const state = makeState({
    acknowledgedAgentsByPaneKey: new Proxy(record, {
      ownKeys(target) {
        enumerations++
        return Reflect.ownKeys(target)
      }
    })
  })
  const batch: WebSessionTabsBatchContext = {
    agentPaneKeysByTabId: null,
    changedRecords: new Set(),
    openFilesIndex: null
  }
  for (const tab of tabs) {
    expect(collectCollidingRetractionPaneKeys(state, [tab], 'host', 'folder', batch).has(tab)).toBe(
      true
    )
  }
  expect(enumerations).toBe(1)
  state.acknowledgedAgentsByPaneKey = {}
  expect(collectCollidingRetractionPaneKeys(state, tabs, 'host', 'folder', batch).size).toBe(0)
})
