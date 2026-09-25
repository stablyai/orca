import { beforeEach, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots
} from '../../src/renderer/src/runtime/web-session-tabs-sync'
import {
  makeState,
  makeSnapshot,
  NOW,
  LEAF_ID,
  SECOND_LEAF_ID,
  resetWebSessionTabsSyncTestState
} from '../../src/renderer/src/runtime/web-session-tabs-sync-test-harness'

vi.mock('../../src/renderer/src/store', () => ({ useAppStore: { setState: vi.fn() } }))
beforeEach(resetWebSessionTabsSyncTestState)

const tabId = toWebTerminalSurfaceTabId('same-host-tab')
const ownPane = makePaneKey(tabId, LEAF_ID)
const sibling = makePaneKey(tabId, SECOND_LEAF_ID)

function snapshot(worktreeId: string, leafId: string, version = 1) {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: `same-host-tab::${leafId}`,
        parentTabId: 'same-host-tab',
        leafId,
        title: 'OMP',
        isActive: false,
        status: 'ready',
        terminal: `term-${leafId}`,
        agentStatus: {
          paneKey: makePaneKey('same-host-tab', leafId),
          tabId: 'same-host-tab',
          worktreeId,
          agentType: 'omp',
          state: 'working',
          prompt: 'running',
          updatedAt: NOW,
          stateStartedAt: NOW,
          stateHistory: []
        }
      }
    ],
    { worktree: worktreeId, snapshotVersion: version }
  )
}

it.each(
  [
    ['host-b', 'folder:same'],
    ['host-b', 'folder:other'],
    ['host-a', 'folder:other'],
    ['host-b', 'repo::C:/worktrees/other']
  ].flatMap(([otherHost, otherWorktree]) =>
    [false, true].flatMap((hydrated) =>
      [false, true].map((batch) => ({ otherHost, otherWorktree, hydrated, batch }))
    )
  )
)(
  'retracts only owned panes: $otherHost/$otherWorktree hydrated=$hydrated batch=$batch',
  ({ otherHost, otherWorktree, hydrated, batch }) => {
    const initial = makeState()
    const a = applyWebSessionTabsSnapshot(initial, snapshot('folder:same', LEAF_ID), 'host-a', NOW)
    const b = applyWebSessionTabsSnapshot(
      initial,
      snapshot(otherWorktree, SECOND_LEAF_ID),
      otherHost,
      NOW
    )
    const state = makeState({
      ...(hydrated ? a : {}),
      agentStatusByPaneKey: { ...a.agentStatusByPaneKey, ...b.agentStatusByPaneKey },
      acknowledgedAgentsByPaneKey: { [ownPane]: 1, [sibling]: 2 },
      paneForegroundAgentByPaneKey: {
        [ownPane]: { agent: 'omp', shellForeground: false },
        [sibling]: { agent: 'omp', shellForeground: false }
      }
    })
    expect(state.agentStatusByPaneKey[sibling]).toBeDefined()
    const empty = makeSnapshot([], { worktree: 'folder:same', snapshotVersion: 2 })
    const patch = batch
      ? applyWebSessionTabsSnapshots(state, [empty], 'host-a', NOW + 1)
      : applyWebSessionTabsSnapshot(state, empty, 'host-a', NOW + 1)
    const after = { ...state, ...patch }
    expect(after.agentStatusByPaneKey[ownPane]).toBeUndefined()
    expect(after.agentStatusByPaneKey[sibling]).toEqual(state.agentStatusByPaneKey[sibling])
    expect(after.acknowledgedAgentsByPaneKey?.[ownPane]).toBeUndefined()
    expect(after.acknowledgedAgentsByPaneKey?.[sibling]).toBe(2)
    expect(after.paneForegroundAgentByPaneKey?.[ownPane]).toBeUndefined()
    expect(after.paneForegroundAgentByPaneKey?.[sibling]).toEqual(
      state.paneForegroundAgentByPaneKey?.[sibling]
    )
    expect(after.recentlyClosedAgentStatusTabIds?.[tabId]).toBeUndefined()
    expect(after.retentionSuppressedPaneKeys?.[sibling]).toBeUndefined()
    expect(after.retentionSuppressedPaneKeys?.[ownPane]).toBe(true)

    const next = {
      ...after,
      ...applyWebSessionTabsSnapshot(
        after,
        snapshot(otherWorktree, SECOND_LEAF_ID, 2),
        otherHost,
        NOW + 2
      )
    }
    expect(next.agentStatusByPaneKey[sibling]).toBeDefined()
    const reopened = {
      ...next,
      ...applyWebSessionTabsSnapshot(next, snapshot('folder:same', LEAF_ID, 3), 'host-a', NOW + 3)
    }
    expect(reopened.agentStatusByPaneKey[ownPane]).toBeDefined()
    expect(reopened.agentStatusByPaneKey[sibling]).toBeDefined()
  }
)

it.each(
  [
    {
      name: 'migration',
      metadata: {
        migrationUnsupportedByPtyId: {
          foreign: {
            ptyId: 'foreign',
            paneKey: sibling,
            reason: 'legacy-numeric-pane-key' as const,
            source: 'local' as const,
            updatedAt: 1
          }
        }
      }
    },
    { name: 'acknowledgement', metadata: { acknowledgedAgentsByPaneKey: { [sibling]: 2 } } },
    {
      name: 'foreground',
      metadata: {
        paneForegroundAgentByPaneKey: {
          [sibling]: { agent: 'omp' as const, shellForeground: false }
        }
      }
    },
    {
      name: 'launch config',
      metadata: {
        agentLaunchConfigByPaneKey: {
          [sibling]: {
            launchConfig: { agentArgs: '', agentEnv: {} },
            registeredAt: 1,
            identity: {}
          }
        }
      }
    }
  ].flatMap((variant) => [false, true].map((batch) => ({ ...variant, batch })))
)('preserves foreign $name without a status row (batch=$batch)', ({ metadata, batch }) => {
  const initial = makeState()
  const own = applyWebSessionTabsSnapshot(initial, snapshot('folder:same', LEAF_ID), 'host-a', NOW)
  applyWebSessionTabsSnapshot(initial, snapshot('folder:other', SECOND_LEAF_ID), 'host-b', NOW)
  const state = makeState({ ...own, ...metadata })
  expect(state.agentStatusByPaneKey[sibling]).toBeUndefined()
  const empty = makeSnapshot([], { worktree: 'folder:same', snapshotVersion: 2 })
  const patch = batch
    ? applyWebSessionTabsSnapshots(state, [empty], 'host-a', NOW + 1)
    : applyWebSessionTabsSnapshot(state, empty, 'host-a', NOW + 1)
  const after = { ...state, ...patch }
  expect(after).toMatchObject(metadata)
  expect(after.agentStatusByPaneKey[ownPane]).toBeUndefined()
  expect(after.recentlyClosedAgentStatusTabIds?.[tabId]).toBeUndefined()
})
