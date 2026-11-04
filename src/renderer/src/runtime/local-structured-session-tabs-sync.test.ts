// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-runtime-capabilities'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

import { buildPersistedUnifiedTabSessionData } from '../lib/workspace-session-unified-tabs'
import { buildHydratedTabState } from '../store/slices/tabs-hydration'
import './local-structured-session-tabs-sync/snapshot-apply'
import { projectLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-projection'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import './local-structured-session-tabs-sync/subscription'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'

const mocks = vi.hoisted(() => ({ recheckUnconfirmedLaunches: vi.fn() }))

vi.mock('../lib/agent-session/launch/structured-agent-session-launch-unconfirmed-recheck', () => ({
  recheckUnconfirmedStructuredAgentLaunches: mocks.recheckUnconfirmedLaunches
}))

const WORKTREE_ID = 'repo-1::worktree-1'
const TERMINAL_ID = 'terminal-1'
const STRUCTURED_ID = 'structured-agent-session-codex-1'
const PRIMARY_GROUP = 'primary-group'
const SECONDARY_GROUP = 'secondary-group'

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionFocusIntentForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.restoreAllMocks()
})

function createSnapshot(): WebSessionTabsSyncState {
  const tabs: Tab[] = [
    {
      id: TERMINAL_ID,
      entityId: TERMINAL_ID,
      groupId: PRIMARY_GROUP,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    {
      id: STRUCTURED_ID,
      entityId: 'codex-1',
      groupId: SECONDARY_GROUP,
      worktreeId: WORKTREE_ID,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 2
    }
  ]
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [WORKTREE_ID]: SECONDARY_GROUP },
    activeTabId: STRUCTURED_ID,
    activeTabIdByWorktree: { [WORKTREE_ID]: STRUCTURED_ID },
    activeTabType: 'agent-session',
    activeTabTypeByWorktree: { [WORKTREE_ID]: 'agent-session' },
    activeWorktreeId: WORKTREE_ID,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: PRIMARY_GROUP,
          worktreeId: WORKTREE_ID,
          activeTabId: TERMINAL_ID,
          tabOrder: [TERMINAL_ID]
        },
        {
          id: SECONDARY_GROUP,
          worktreeId: WORKTREE_ID,
          activeTabId: STRUCTURED_ID,
          tabOrder: [STRUCTURED_ID]
        }
      ]
    },
    layoutByWorktree: {
      [WORKTREE_ID]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: PRIMARY_GROUP },
        second: { type: 'leaf', groupId: SECONDARY_GROUP }
      }
    },
    openFiles: [],
    editorBuffers: {},
    ptyIdsByTabId: { [TERMINAL_ID]: ['pty-1'] },
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: { [WORKTREE_ID]: [TERMINAL_ID, STRUCTURED_ID] },
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabs },
    unreadTerminalTabs: {},
    sortEpoch: 0
  }
}

function expectExactSplit(state: {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: WebSessionTabsSyncState['groupsByWorktree']
  layoutByWorktree: WebSessionTabsSyncState['layoutByWorktree']
  activeGroupIdByWorktree: Record<string, string>
}): void {
  expect(state.layoutByWorktree[WORKTREE_ID]).toEqual({
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', groupId: PRIMARY_GROUP },
    second: { type: 'leaf', groupId: SECONDARY_GROUP }
  })
  expect(state.groupsByWorktree[WORKTREE_ID]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: PRIMARY_GROUP,
        activeTabId: TERMINAL_ID,
        tabOrder: [TERMINAL_ID]
      }),
      expect.objectContaining({
        id: SECONDARY_GROUP,
        activeTabId: STRUCTURED_ID,
        tabOrder: [STRUCTURED_ID]
      })
    ])
  )
  expect(state.groupsByWorktree[WORKTREE_ID]).toHaveLength(2)
  expect(state.unifiedTabsByWorktree[WORKTREE_ID]).toEqual([
    expect.objectContaining({ id: TERMINAL_ID, groupId: PRIMARY_GROUP, contentType: 'terminal' }),
    expect.objectContaining({
      id: STRUCTURED_ID,
      groupId: SECONDARY_GROUP,
      contentType: 'agent-session'
    })
  ])
  expect(state.activeGroupIdByWorktree[WORKTREE_ID]).toBe(SECONDARY_GROUP)
}

describe('local structured session tab projection', () => {
  it('starts the session-tabs inventory without waiting for the capability refresh', async () => {
    const priorApi = window.api
    let releaseStatus = (): void => undefined
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    const getStatus = vi.fn(async () => {
      await statusGate
      return { capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
    })
    const call = vi.fn().mockResolvedValue({ ok: true, result: { snapshots: [] } })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtime: { getStatus, call } }
    })
    try {
      vi.resetModules()
      const { restoreLocalStructuredSessionTabsOnce } =
        await import('./local-structured-session-tabs-sync/inventory-refresh')
      let settled = false
      const restored = restoreLocalStructuredSessionTabsOnce().finally(() => {
        settled = true
      })
      expect(getStatus).toHaveBeenCalledOnce()
      // The inventory RPC must already be in flight while the capability refresh is pending.
      expect(call).toHaveBeenCalledWith({ method: 'session.tabs.listAll', params: {} })
      // ...and overlapping must not let the restore open the gate before capabilities land.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      releaseStatus()
      await restored
      expect(call).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
    }
  })

  it('preserves the exact local split through apply, persistence, and hydration', () => {
    const state = createSnapshot()
    const snapshot = {
      worktree: WORKTREE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 2,
      activeGroupId: SECONDARY_GROUP,
      activeTabId: 'agent-session:codex-1',
      activeTabType: 'agent-session',
      tabGroups: [
        { id: PRIMARY_GROUP, activeTabId: TERMINAL_ID, tabOrder: [TERMINAL_ID] },
        {
          id: SECONDARY_GROUP,
          activeTabId: 'agent-session:codex-1',
          tabOrder: ['agent-session:codex-1']
        }
      ],
      tabGroupLayout: state.layoutByWorktree[WORKTREE_ID],
      tabs: [
        {
          type: 'terminal',
          id: TERMINAL_ID,
          parentTabId: TERMINAL_ID,
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'term-1',
          ptyId: 'pty-1',
          isActive: false
        },
        {
          type: 'agent-session',
          id: 'agent-session:codex-1',
          title: 'Codex Chat',
          sessionId: 'codex-1',
          agent: 'codex',
          isActive: true
        }
      ]
    } satisfies RuntimeMobileSessionTabsResult

    const projected = projectLocalStructuredSessionTabs(snapshot)
    const patch = applyWebSessionTabsSnapshot(
      state,
      projected,
      'local-structured-session',
      1_700_000_000_000,
      { preserveLocalLayout: true }
    )
    const applied = { ...state, ...patch } as WebSessionTabsSyncState

    expectExactSplit(applied)

    const session: WorkspaceSessionState = {
      activeRepoId: null,
      activeWorktreeId: WORKTREE_ID,
      activeTabId: STRUCTURED_ID,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...buildPersistedUnifiedTabSessionData(applied)
    }
    const hydrated = buildHydratedTabState(session, new Set([WORKTREE_ID]))

    expectExactSplit(hydrated)
  })
})
