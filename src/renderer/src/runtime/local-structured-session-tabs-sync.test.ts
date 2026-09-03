// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner'
import { buildPersistedUnifiedTabSessionData } from '../lib/workspace-session-unified-tabs'
import { buildHydratedTabState } from '../store/slices/tabs-hydration'
import {
  applyLocalStructuredSessionTabSnapshots,
  projectLocalStructuredSessionTabs,
  resetLocalStructuredSessionVersionForTests,
  startLocalStructuredSessionTabsSync
} from './local-structured-session-tabs-sync'
import {
  applyWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'

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
  it('reconnects after a streaming subscription reports an error', async () => {
    vi.useFakeTimers()
    const priorApi = window.api
    const callbacks: ((response: {
      ok: false
      error: { code: string; message: string }
    }) => void)[] = []
    const unsubscribes: ReturnType<typeof vi.fn>[] = []
    const subscribe = vi.fn(async (_args: unknown, callback: (response: unknown) => void) => {
      callbacks.push(
        callback as (response: { ok: false; error: { code: string; message: string } }) => void
      )
      const unsubscribe = vi.fn()
      unsubscribes.push(unsubscribe)
      return { unsubscribe, sendBinary: vi.fn() }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          getStatus: vi.fn().mockResolvedValue({
            capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
          }),
          call: vi.fn().mockResolvedValue({
            ok: true,
            result: { snapshots: [] }
          }),
          subscribe
        }
      }
    })
    try {
      await startLocalStructuredSessionTabsSync({
        isDisposed: () => false,
        setUnsubscribe: () => undefined
      })
      expect(subscribe).toHaveBeenCalledOnce()

      callbacks[0]?.({ ok: false, error: { code: 'runtime_unavailable', message: 'offline' } })
      await vi.advanceTimersByTimeAsync(249)
      expect(subscribe).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()

      expect(subscribe).toHaveBeenCalledTimes(2)
      expect(unsubscribes[0]).toHaveBeenCalledOnce()
      expect(unsubscribes[1]).not.toHaveBeenCalled()

      // A late error from the fenced generation must not start another retry.
      callbacks[0]?.({ ok: false, error: { code: 'runtime_unavailable', message: 'late' } })
      await vi.advanceTimersByTimeAsync(5000)
      expect(subscribe).toHaveBeenCalledTimes(2)
    } finally {
      Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
    }
  })

  it('accepts a newer session after merged content returns to the base epoch', () => {
    const state = createSnapshot()
    const base = {
      ...({
        worktree: WORKTREE_ID,
        publicationEpoch: 'renderer:generation-1',
        snapshotVersion: 4,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      } satisfies RuntimeMobileSessionTabsResult)
    }
    const withChat = {
      ...base,
      snapshotVersion: 5,
      tabs: [
        {
          type: 'agent-session' as const,
          id: STRUCTURED_ID,
          title: 'Codex Chat',
          sessionId: 'codex-1',
          agent: 'codex' as const,
          isActive: true
        }
      ]
    }
    const afterClose = { ...base, snapshotVersion: 6 }
    const next = applyLocalStructuredSessionTabSnapshots(
      state,
      [
        base,
        withChat,
        afterClose,
        { ...base, snapshotVersion: 7, tabs: [{ ...withChat.tabs[0], isActive: true }] }
      ],
      'local-structured-session'
    )
    expect(next.unifiedTabsByWorktree[WORKTREE_ID]).toEqual(
      expect.arrayContaining([expect.objectContaining({ contentType: 'agent-session' })])
    )
  })

  it('survives repeated create-close cycles under one publisher generation', () => {
    let state = createSnapshot()
    let version = 10
    for (const sessionId of ['session-1', 'session-2', 'session-3']) {
      state = applyLocalStructuredSessionTabSnapshots(state, [
        structuredInventory('renderer:generation-1', version++, sessionId)
      ])
      expect(state.unifiedTabsByWorktree[WORKTREE_ID]).toEqual(
        expect.arrayContaining([expect.objectContaining({ entityId: sessionId })])
      )

      const closed = structuredInventory('renderer:generation-1', version++, sessionId)
      state = applyLocalStructuredSessionTabSnapshots(state, [{ ...closed, tabs: [] }])
      expect(state.unifiedTabsByWorktree[WORKTREE_ID]).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ contentType: 'agent-session' })])
      )
    }
  })

  it('forgets publisher versions when a worktree is removed', () => {
    type OwnerState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState
    const owner = {
      id: WORKTREE_ID,
      repoId: 'repo-1',
      hostId: undefined,
      runtimeOwnerEnvironmentId: undefined
    }
    let state = {
      ...createSnapshot(),
      worktreesByRepo: { 'repo-1': [owner] }
    } as OwnerState
    state = applyLocalStructuredSessionTabSnapshots(state, [
      structuredInventory('epoch-1', 10, 'session-old')
    ])
    state = applyLocalStructuredSessionTabSnapshots(
      { ...state, worktreesByRepo: {}, unifiedTabsByWorktree: {} },
      []
    )
    state = applyLocalStructuredSessionTabSnapshots(
      { ...state, worktreesByRepo: { 'repo-1': [owner] } },
      [structuredInventory('epoch-1', 1, 'session-new')]
    )
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'session-new' })])
    )
  })

  it('forgets publisher versions when a folder workspace is removed', () => {
    type OwnerState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState
    const folderKey = 'folder:folder-1'
    const folder = { id: 'folder-1' } as NonNullable<OwnerState['folderWorkspaces']>[number]
    let state = {
      ...createSnapshot(),
      activeWorktreeId: folderKey,
      unifiedTabsByWorktree: { [folderKey]: [] },
      folderWorkspaces: [folder]
    } as OwnerState
    const folderSnapshot = (version: number, sessionId: string) => ({
      ...structuredInventory('epoch-1', version, sessionId),
      worktree: folderKey
    })
    state = applyLocalStructuredSessionTabSnapshots(state, [folderSnapshot(10, 'session-old')])
    state = applyLocalStructuredSessionTabSnapshots(
      { ...state, folderWorkspaces: [], unifiedTabsByWorktree: {} },
      []
    )
    state = applyLocalStructuredSessionTabSnapshots(
      { ...state, folderWorkspaces: [folder], unifiedTabsByWorktree: { [folderKey]: [] } },
      [folderSnapshot(1, 'session-new')]
    )
    expect(state.unifiedTabsByWorktree[folderKey]).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'session-new' })])
    )
  })

  it('drops terminal topology while retaining structured tabs', () => {
    const snapshot = {
      worktree: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'structured-group',
      activeTabId: 'agent-session:codex-1',
      activeTabType: 'agent-session',
      tabGroups: [
        {
          id: 'terminal-group',
          activeTabId: 'terminal-1',
          tabOrder: ['terminal-1']
        },
        {
          id: 'structured-group',
          activeTabId: 'agent-session:codex-1',
          tabOrder: ['agent-session:codex-1']
        }
      ],
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'terminal-group' },
        second: { type: 'leaf', groupId: 'structured-group' }
      },
      tabs: [
        {
          type: 'terminal',
          id: 'terminal-1',
          parentTabId: 'terminal-1',
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

    expect(projectLocalStructuredSessionTabs(snapshot)).toMatchObject({
      tabGroups: [
        {
          id: 'structured-group',
          activeTabId: 'agent-session:codex-1',
          tabOrder: ['agent-session:codex-1']
        }
      ],
      tabGroupLayout: undefined,
      tabs: [expect.objectContaining({ type: 'agent-session', agent: 'codex' })]
    })
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

  it('repairs stale legacy active pointers when restart republishes the native tab', () => {
    const state = createSnapshot()
    const restartedState: WebSessionTabsSyncState = {
      ...state,
      activeTabId: TERMINAL_ID,
      activeTabIdByWorktree: { [WORKTREE_ID]: TERMINAL_ID },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' },
      activeGroupIdByWorktree: { [WORKTREE_ID]: SECONDARY_GROUP }
    }
    const snapshot = {
      worktree: WORKTREE_ID,
      publicationEpoch: 'structured:restart-1',
      snapshotVersion: 1,
      activeGroupId: SECONDARY_GROUP,
      activeTabId: 'agent-session:codex-1',
      activeTabType: 'agent-session' as const,
      tabGroups: [
        {
          id: SECONDARY_GROUP,
          activeTabId: 'agent-session:codex-1',
          tabOrder: ['agent-session:codex-1']
        }
      ],
      tabs: [
        {
          type: 'agent-session' as const,
          id: 'agent-session:codex-1',
          title: 'Codex Chat',
          sessionId: 'codex-1',
          agent: 'codex' as const,
          isActive: true
        }
      ]
    } satisfies RuntimeMobileSessionTabsResult

    const projected = projectLocalStructuredSessionTabs(snapshot)
    const patch = applyWebSessionTabsSnapshot(
      restartedState,
      projected,
      'local-structured-session',
      1_700_000_000_000,
      { preserveLocalLayout: true }
    )
    const applied = { ...restartedState, ...patch } as WebSessionTabsSyncState

    expect(applied.activeTabTypeByWorktree[WORKTREE_ID]).toBe('agent-session')
    expect(applied.activeTabIdByWorktree[WORKTREE_ID]).toBe(STRUCTURED_ID)
  })

  it('honors the focus intent for a newly published local structured tab', () => {
    const initial = createSnapshot()
    const state: WebSessionTabsSyncState = {
      ...initial,
      activeGroupIdByWorktree: { [WORKTREE_ID]: PRIMARY_GROUP },
      activeTabId: TERMINAL_ID,
      activeTabIdByWorktree: { [WORKTREE_ID]: TERMINAL_ID },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' },
      groupsByWorktree: {
        [WORKTREE_ID]: initial.groupsByWorktree[WORKTREE_ID]!.map((group) =>
          group.id === PRIMARY_GROUP ? { ...group, activeTabId: TERMINAL_ID } : group
        )
      }
    }
    const snapshot = {
      worktree: WORKTREE_ID,
      publicationEpoch: 'structured:epoch-1',
      snapshotVersion: 1,
      activeGroupId: SECONDARY_GROUP,
      activeTabId: 'agent-session:codex-1',
      activeTabType: 'agent-session' as const,
      tabGroups: [
        { id: PRIMARY_GROUP, activeTabId: TERMINAL_ID, tabOrder: [TERMINAL_ID] },
        {
          id: SECONDARY_GROUP,
          activeTabId: 'agent-session:codex-1',
          tabOrder: ['agent-session:codex-1']
        }
      ],
      tabs: [
        {
          type: 'agent-session' as const,
          id: 'agent-session:codex-1',
          title: 'Codex Chat',
          sessionId: 'codex-1',
          agent: 'codex' as const,
          isActive: true
        }
      ]
    } satisfies RuntimeMobileSessionTabsResult

    recordWebSessionFocusIntent(
      { environmentId: 'local-structured-session' },
      WORKTREE_ID,
      'agent-session:codex-1',
      undefined,
      TERMINAL_ID
    )
    const patch = applyWebSessionTabsSnapshot(
      state,
      snapshot,
      'local-structured-session',
      1_700_000_000_000,
      { preserveLocalLayout: true }
    )
    const applied = { ...state, ...patch } as WebSessionTabsSyncState

    expect(applied.activeTabIdByWorktree[WORKTREE_ID]).toBe(STRUCTURED_ID)
    expect(applied.activeTabTypeByWorktree[WORKTREE_ID]).toBe('agent-session')
    expect(applied.groupsByWorktree[WORKTREE_ID]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: SECONDARY_GROUP, activeTabId: STRUCTURED_ID })
      ])
    )
  })

  it('rejects a reordered list reply after a newer subscription frame', () => {
    const stale = structuredInventory('epoch-a', 7, 'stale-session')
    const fresh = structuredInventory('epoch-a', 8, 'fresh-session')
    const afterStale = applyLocalStructuredSessionTabSnapshots(createSnapshot(), [stale])
    const afterFresh = applyLocalStructuredSessionTabSnapshots(afterStale, [fresh])
    const afterReorderedList = applyLocalStructuredSessionTabSnapshots(afterFresh, [stale])

    expect(afterReorderedList).toBe(afterFresh)
    expect(afterReorderedList.unifiedTabsByWorktree[WORKTREE_ID]).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'fresh-session' })])
    )
    expect(afterReorderedList.unifiedTabsByWorktree[WORKTREE_ID]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'stale-session' })])
    )
  })

  it('rejects same-version replay but accepts a new owner epoch', () => {
    const first = structuredInventory('epoch-a', 8, 'session-a')
    const afterFirst = applyLocalStructuredSessionTabSnapshots(createSnapshot(), [first])
    const replayed = applyLocalStructuredSessionTabSnapshots(afterFirst, [first])
    const restarted = applyLocalStructuredSessionTabSnapshots(replayed, [
      structuredInventory('epoch-b', 1, 'session-b')
    ])

    expect(replayed).toBe(afterFirst)
    expect(restarted).not.toBe(replayed)
    expect(restarted.unifiedTabsByWorktree[WORKTREE_ID]).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'session-b' })])
    )
  })

  it('rejects delayed frames from a retired predecessor epoch', () => {
    const initial = applyLocalStructuredSessionTabSnapshots(createSnapshot(), [
      structuredInventory('epoch-1', 5, 'session-one')
    ])
    const restarted = applyLocalStructuredSessionTabSnapshots(initial, [
      structuredInventory('epoch-2', 1, 'session-two')
    ])
    const delayed = applyLocalStructuredSessionTabSnapshots(restarted, [
      structuredInventory('epoch-1', 6, 'stale-session')
    ])

    expect(delayed).toBe(restarted)
    expect(delayed.unifiedTabsByWorktree[WORKTREE_ID]).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'session-two' })])
    )
    expect(delayed.unifiedTabsByWorktree[WORKTREE_ID]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: 'stale-session' })])
    )
  })
})

function structuredInventory(
  publicationEpoch: string,
  snapshotVersion: number,
  sessionId: string
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: SECONDARY_GROUP,
    activeTabId: `agent-session:${sessionId}`,
    activeTabType: 'agent-session',
    tabGroups: [
      {
        id: SECONDARY_GROUP,
        activeTabId: `agent-session:${sessionId}`,
        tabOrder: [`agent-session:${sessionId}`]
      }
    ],
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${sessionId}`,
        title: 'Codex Chat',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}
