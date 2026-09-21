import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { toWebTerminalSurfaceTabId } from './web-runtime-session'
import {
  applyLocalStructuredSessionTabSnapshots,
  projectLocalStructuredSessionTabs
} from './local-structured-session-tabs-sync'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const REMOTE_GROUP = 'remote-group'
const STRUCTURED_GROUP = 'structured-group'
const HOST_TAB_ID = 'host-tab-1'
const MIRRORED_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)

function terminalSnapshot(version = 1): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        title: 'Terminal',
        status: 'ready',
        terminal: 'term-host',
        isActive: true
      }
    ],
    {
      snapshotVersion: version,
      activeGroupId: REMOTE_GROUP,
      tabGroups: [{ id: REMOTE_GROUP, activeTabId: HOST_TAB_ID, tabOrder: [HOST_TAB_ID] }],
      tabGroupLayout: { type: 'leaf', groupId: REMOTE_GROUP }
    }
  )
}

function pendingTerminalSnapshot(): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        title: 'Starting terminal',
        status: 'pending-handle',
        terminal: null,
        isActive: true
      }
    ],
    {
      activeGroupId: REMOTE_GROUP,
      tabGroups: [{ id: REMOTE_GROUP, activeTabId: HOST_TAB_ID, tabOrder: [HOST_TAB_ID] }],
      tabGroupLayout: { type: 'leaf', groupId: REMOTE_GROUP }
    }
  )
}

function structuredSnapshot(): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'agent-session',
        id: 'agent-session:codex-1',
        title: 'Codex Chat',
        sessionId: 'codex-1',
        agent: 'codex',
        isActive: true
      }
    ],
    {
      publicationEpoch: 'structured:epoch-1',
      activeGroupId: STRUCTURED_GROUP,
      activeTabId: 'agent-session:codex-1',
      activeTabType: 'agent-session',
      tabGroups: [
        {
          id: STRUCTURED_GROUP,
          activeTabId: 'agent-session:codex-1',
          tabOrder: ['agent-session:codex-1']
        }
      ],
      tabGroupLayout: { type: 'leaf', groupId: STRUCTURED_GROUP }
    }
  )
}

function applySnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  options?: Parameters<typeof applyWebSessionTabsSnapshot>[4]
): WebSessionTabsSyncState {
  return {
    ...state,
    ...applyWebSessionTabsSnapshot(state, snapshot, environmentId, NOW, options)
  } as WebSessionTabsSyncState
}

function expectRemoteTerminalTopology(state: WebSessionTabsSyncState): void {
  expect(state.tabsByWorktree[WT]).toEqual([
    expect.objectContaining({ id: MIRRORED_TAB_ID, ptyId: `remote:${ENV}@@term-host` })
  ])
  expect(state.unifiedTabsByWorktree[WT]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: MIRRORED_TAB_ID, contentType: 'terminal' })
    ])
  )
  expect(state.groupsByWorktree[WT]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: REMOTE_GROUP,
        tabOrder: expect.arrayContaining([MIRRORED_TAB_ID])
      })
    ])
  )
  expect(state.activeGroupIdByWorktree[WT]).toBe(REMOTE_GROUP)
  expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: REMOTE_GROUP })
  expect(state.activeTabIdByWorktree[WT]).toBe(MIRRORED_TAB_ID)
  expect(state.activeTabTypeByWorktree[WT]).toBe('terminal')
}

describe('local structured session tab host isolation', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('materializes a complete terminal group and layout into an otherwise empty paired state', () => {
    const state = applySnapshot(makeState(), terminalSnapshot(), ENV)

    expectRemoteTerminalTopology(state)
  })

  it('materializes the active paired worktree without disturbing another worktree layout', () => {
    const otherWorktree = 'repo::/other-worktree'
    const otherLayout = { type: 'leaf' as const, groupId: 'other-group' }
    const state = applySnapshot(
      makeState({ layoutByWorktree: { [otherWorktree]: otherLayout } }),
      terminalSnapshot(),
      ENV
    )

    expectRemoteTerminalTopology(state)
    expect(state.layoutByWorktree[otherWorktree]).toBe(otherLayout)
  })

  it('keeps ordinary remote topology stable across agent-only inventory frames', () => {
    let state = applySnapshot(makeState(), terminalSnapshot(), ENV)
    state = applySnapshot(
      state,
      projectLocalStructuredSessionTabs(structuredSnapshot()),
      'local-structured-session',
      {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      }
    )
    expectRemoteTerminalTopology(state)

    state = applySnapshot(state, terminalSnapshot(2), ENV)
    expectRemoteTerminalTopology(state)
  })

  it('keeps startup terminal topology through pending, ready, and repeated ready frames', () => {
    let state = applySnapshot(makeState(), pendingTerminalSnapshot(), ENV)
    expect(state.tabsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: MIRRORED_TAB_ID, ptyId: null })
    ])
    expect(state.groupsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: REMOTE_GROUP, tabOrder: [MIRRORED_TAB_ID] })
    ])
    expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: REMOTE_GROUP })

    state = applySnapshot(state, terminalSnapshot(2), ENV)
    expectRemoteTerminalTopology(state)
    const stableGroups = state.groupsByWorktree
    const stableLayouts = state.layoutByWorktree

    state = applySnapshot(state, terminalSnapshot(3), ENV)
    expectRemoteTerminalTopology(state)
    expect(state.groupsByWorktree).toBe(stableGroups)
    expect(state.layoutByWorktree).toBe(stableLayouts)
  })

  it.each([
    ['paired', toRuntimeExecutionHostId(ENV)],
    ['SSH', toSshExecutionHostId('ssh-target-1')]
  ])('does not project local structured inventory into a %s-owned workspace', (_name, hostId) => {
    const state = makeState({
      activeWorkspaceExecutionHostId: hostId
    } as Partial<WebSessionTabsSyncState>)

    const next = applyLocalStructuredSessionTabSnapshots(
      state,
      [structuredSnapshot()],
      undefined,
      NOW
    )

    expect(next).toBe(state)
  })
})
