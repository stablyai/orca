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
import type { WebSessionTabsSyncState } from './state'
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
