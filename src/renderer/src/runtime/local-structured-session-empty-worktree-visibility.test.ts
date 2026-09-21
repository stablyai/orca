import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { projectLocalStructuredSessionTabs } from './local-structured-session-tabs-sync'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import { collectClientLayoutGroupIds } from './web-session-client-owned-tab-placement'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'

// Why: a structured session created on a worktree with no prior tabs must land in a
// group the local layout actually renders. The host publishes it inside a
// "headless-terminals:" group; adopting that group while freezing the local layout
// leaves the tab in store but permanently off screen (empty-worktree launch P0).

const GIT_WT = 'repo-1::/tmp/wt1'
const FOLDER_WT = 'folder:folder-1'
const LOCAL_ROOT = 'local-root-group'

afterEach(() => {
  resetWebSessionFocusIntentForTests()
})

function emptyState(overrides: Partial<WebSessionTabsSyncState>): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: GIT_WT,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

function headlessSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'structured:epoch-1',
    snapshotVersion: 1,
    activeGroupId: `headless-terminals:${worktreeId}`,
    activeTabId: 'agent-session:codex-1',
    activeTabType: 'agent-session',
    tabGroups: [
      {
        id: `headless-terminals:${worktreeId}`,
        activeTabId: 'agent-session:codex-1',
        tabOrder: ['agent-session:codex-1']
      }
    ],
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:codex-1',
        title: 'Codex Chat',
        sessionId: 'codex-1',
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

function applyStructured(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(
    state,
    projectLocalStructuredSessionTabs(snapshot),
    'local-structured-session',
    1_700_000_000_000,
    { preserveLocalLayout: true, terminalPtyMode: 'local' }
  )
  return { ...state, ...patch } as WebSessionTabsSyncState
}

/** The visibility contract: the published chat tab sits in a group the layout renders. */
function expectChatTabRendered(state: WebSessionTabsSyncState, worktreeId: string): Tab {
  const chatTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'agent-session'
  )
  expect(chatTab).toBeDefined()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const owningGroup = groups.find((group) => group.tabOrder.includes(chatTab!.id))
  expect(owningGroup).toBeDefined()
  expect(chatTab!.groupId).toBe(owningGroup!.id)
  const renderedGroupIds = collectClientLayoutGroupIds(state.layoutByWorktree[worktreeId] ?? null)
  expect(renderedGroupIds.has(owningGroup!.id)).toBe(true)
  return chatTab!
}

describe('structured session visibility on empty worktrees', () => {
  it('adopts the session into the rendered local root leaf when its group record is missing (git worktree)', () => {
    // The observed P0 store state: the layout leaf exists but its group record does not.
    const state = emptyState({
      layoutByWorktree: { [GIT_WT]: { type: 'leaf', groupId: LOCAL_ROOT } },
      activeGroupIdByWorktree: { [GIT_WT]: LOCAL_ROOT }
    })

    const applied = applyStructured(state, headlessSnapshot(GIT_WT))

    const chatTab = expectChatTabRendered(applied, GIT_WT)
    expect(chatTab.groupId).toBe(LOCAL_ROOT)
    expect(applied.layoutByWorktree[GIT_WT]).toEqual({ type: 'leaf', groupId: LOCAL_ROOT })
  })

  it('materializes a rendered group on a truly empty git worktree', () => {
    const applied = applyStructured(emptyState({}), headlessSnapshot(GIT_WT))

    expectChatTabRendered(applied, GIT_WT)
  })

  it('materializes a rendered group on a truly empty folder workspace', () => {
    const applied = applyStructured(
      emptyState({ activeWorktreeId: FOLDER_WT }),
      headlessSnapshot(FOLDER_WT)
    )

    expectChatTabRendered(applied, FOLDER_WT)
  })

  it('adopts the session into an existing empty local root group', () => {
    const state = emptyState({
      groupsByWorktree: {
        [GIT_WT]: [{ id: LOCAL_ROOT, worktreeId: GIT_WT, activeTabId: null, tabOrder: [] }]
      },
      layoutByWorktree: { [GIT_WT]: { type: 'leaf', groupId: LOCAL_ROOT } },
      activeGroupIdByWorktree: { [GIT_WT]: LOCAL_ROOT }
    })

    const applied = applyStructured(state, headlessSnapshot(GIT_WT))

    const chatTab = expectChatTabRendered(applied, GIT_WT)
    expect(chatTab.groupId).toBe(LOCAL_ROOT)
  })

  it('keeps the folder-workspace local split intact while placing the session beside the terminal', () => {
    const terminalTab: Tab = {
      id: 'u-term-1',
      entityId: 'term-1',
      groupId: LOCAL_ROOT,
      worktreeId: FOLDER_WT,
      contentType: 'terminal',
      label: 'Terminal 1',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const state = emptyState({
      activeWorktreeId: FOLDER_WT,
      tabsByWorktree: {
        [FOLDER_WT]: [
          {
            id: 'term-1',
            worktreeId: FOLDER_WT,
            ptyId: 'pty-1',
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'term-1': ['pty-1'] },
      unifiedTabsByWorktree: { [FOLDER_WT]: [terminalTab] },
      groupsByWorktree: {
        [FOLDER_WT]: [
          {
            id: LOCAL_ROOT,
            worktreeId: FOLDER_WT,
            activeTabId: 'u-term-1',
            tabOrder: ['u-term-1']
          }
        ]
      },
      layoutByWorktree: { [FOLDER_WT]: { type: 'leaf', groupId: LOCAL_ROOT } },
      activeGroupIdByWorktree: { [FOLDER_WT]: LOCAL_ROOT }
    })

    const applied = applyStructured(state, headlessSnapshot(FOLDER_WT))

    const chatTab = expectChatTabRendered(applied, FOLDER_WT)
    expect(chatTab.groupId).toBe(LOCAL_ROOT)
    const rootGroup = applied.groupsByWorktree[FOLDER_WT]?.find((group) => group.id === LOCAL_ROOT)
    expect(rootGroup?.tabOrder).toEqual(['u-term-1', chatTab.id])
    expect(applied.layoutByWorktree[FOLDER_WT]).toEqual({ type: 'leaf', groupId: LOCAL_ROOT })
  })
})
