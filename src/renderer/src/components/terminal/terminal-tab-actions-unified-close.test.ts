import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

// Why: drives the real closeTerminalTab orchestrator against the real store so the
// unified close contract (MRU/neighbor successor, renderable-count deactivation gate)
// is exercised end to end. Slice-level tests pass without the orchestrator fix and
// would be vacuous for these regressions.

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => null),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null)
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn(() => Promise.resolve())
}))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
createTabsSliceMockApi()

const { createTestStore, makeTab, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()

vi.mock('@/store', () => ({ useAppStore: store }))

const { closeTerminalTab } = await import('./terminal-tab-actions')

const GIT_WT = 'repo1::/tmp/wt1'
const FOLDER_WT = 'folder:folder-1'
const GROUP = 'group-1'

function seedWorktreeWithTabs(
  worktreeId: string,
  args: {
    terminalIds: string[]
    /** Unified group order; entries are unified tab ids ("u-" + terminal id, or the chat id). */
    groupOrder: string[]
    /** MRU stack, most recent last. */
    recentTabIds: string[]
    activeUnifiedTabId: string
    activeTerminalId: string
    includeChatTab?: boolean
  }
): void {
  const chatTab = makeUnifiedTab({
    id: 'chat-1',
    entityId: 'codex-session-1',
    groupId: GROUP,
    worktreeId,
    contentType: 'agent-session',
    label: 'Codex Chat'
  })
  const unifiedByTabId = new Map(
    args.terminalIds.map((terminalId) => [
      `u-${terminalId}`,
      makeUnifiedTab({
        id: `u-${terminalId}`,
        entityId: terminalId,
        groupId: GROUP,
        worktreeId,
        contentType: 'terminal'
      })
    ])
  )
  if (args.includeChatTab !== false) {
    unifiedByTabId.set(chatTab.id, chatTab)
  }
  // Why: keep the unified array in group order so insertion-order assertions are real.
  const unifiedTabs = args.groupOrder.flatMap((tabId) => {
    const tab = unifiedByTabId.get(tabId)
    return tab ? [tab] : []
  })
  seedStore(store, {
    activeWorktreeId: worktreeId,
    worktreesByRepo: {
      repo1: [makeWorktree({ id: GIT_WT, repoId: 'repo1', path: '/tmp/wt1' })]
    },
    tabsByWorktree: {
      [worktreeId]: args.terminalIds.map((terminalId) => makeTab({ id: terminalId, worktreeId }))
    },
    unifiedTabsByWorktree: {
      [worktreeId]: unifiedTabs
    },
    groupsByWorktree: {
      [worktreeId]: [
        makeTabGroup({
          id: GROUP,
          worktreeId,
          activeTabId: args.activeUnifiedTabId,
          tabOrder: args.groupOrder,
          recentTabIds: args.recentTabIds
        })
      ]
    },
    layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [worktreeId]: GROUP },
    activeTabId: args.activeTerminalId,
    activeTabIdByWorktree: { [worktreeId]: args.activeTerminalId },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [worktreeId]: 'terminal' },
    openFiles: [],
    browserTabsByWorktree: {}
  } as Partial<AppState>)
}

function group(worktreeId: string) {
  return store.getState().groupsByWorktree[worktreeId]?.find((entry) => entry.id === GROUP)
}

beforeEach(() => {
  store.setState({
    activeWorktreeId: null,
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    openFiles: []
  } as Partial<AppState>)
})

describe('closeTerminalTab unified close contract', () => {
  it('keeps the git worktree active and focuses the chat tab when the last terminal closes', () => {
    seedWorktreeWithTabs(GIT_WT, {
      terminalIds: ['term-1'],
      groupOrder: ['u-term-1', 'chat-1'],
      recentTabIds: ['chat-1', 'u-term-1'],
      activeUnifiedTabId: 'u-term-1',
      activeTerminalId: 'term-1'
    })

    closeTerminalTab('term-1')

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(GIT_WT)
    expect(state.activeTabType).toBe('agent-session')
    expect(group(GIT_WT)?.activeTabId).toBe('chat-1')
    expect(state.unifiedTabsByWorktree[GIT_WT]?.map((tab) => tab.id)).toEqual(['chat-1'])
  })

  it('keeps the folder workspace active and focuses the chat tab when the last terminal closes', () => {
    seedWorktreeWithTabs(FOLDER_WT, {
      terminalIds: ['term-1'],
      groupOrder: ['u-term-1', 'chat-1'],
      recentTabIds: ['chat-1', 'u-term-1'],
      activeUnifiedTabId: 'u-term-1',
      activeTerminalId: 'term-1'
    })

    closeTerminalTab('term-1')

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(FOLDER_WT)
    expect(state.activeTabType).toBe('agent-session')
    expect(group(FOLDER_WT)?.activeTabId).toBe('chat-1')
  })

  it('falls back to the most recent chat tab, not the next terminal, when closing among two terminals', () => {
    seedWorktreeWithTabs(GIT_WT, {
      terminalIds: ['term-1', 'term-2'],
      groupOrder: ['u-term-1', 'chat-1', 'u-term-2'],
      recentTabIds: ['u-term-2', 'chat-1', 'u-term-1'],
      activeUnifiedTabId: 'u-term-1',
      activeTerminalId: 'term-1'
    })

    closeTerminalTab('term-1')

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(GIT_WT)
    expect(group(GIT_WT)?.activeTabId).toBe('chat-1')
    expect(state.activeTabType).toBe('agent-session')
    // Why: insertion order must survive the close — only the closed tab drops out.
    expect(state.unifiedTabsByWorktree[GIT_WT]?.map((tab) => tab.id)).toEqual([
      'chat-1',
      'u-term-2'
    ])
    expect(group(GIT_WT)?.tabOrder).toEqual(['chat-1', 'u-term-2'])
  })

  it('still deactivates the worktree when the last renderable tab closes', () => {
    seedWorktreeWithTabs(GIT_WT, {
      terminalIds: ['term-1'],
      groupOrder: ['u-term-1'],
      recentTabIds: ['u-term-1'],
      activeUnifiedTabId: 'u-term-1',
      activeTerminalId: 'term-1',
      includeChatTab: false
    })

    closeTerminalTab('term-1')

    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('lands on an open editor tab instead of deactivating when the last terminal closes', () => {
    seedWorktreeWithTabs(GIT_WT, {
      terminalIds: ['term-1'],
      groupOrder: ['u-term-1', 'editor-1'],
      recentTabIds: ['editor-1', 'u-term-1'],
      activeUnifiedTabId: 'u-term-1',
      activeTerminalId: 'term-1',
      includeChatTab: false
    })
    store.setState((state) => ({
      openFiles: [
        {
          id: 'file-1',
          worktreeId: GIT_WT,
          filePath: 'file-1',
          relativePath: 'file.ts',
          language: 'typescript',
          isDirty: false,
          mode: 'edit' as const
        }
      ],
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [GIT_WT]: [
          ...(state.unifiedTabsByWorktree[GIT_WT] ?? []),
          makeUnifiedTab({
            id: 'editor-1',
            entityId: 'file-1',
            groupId: GROUP,
            worktreeId: GIT_WT,
            contentType: 'editor'
          })
        ]
      }
    }))

    closeTerminalTab('term-1')

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(GIT_WT)
    expect(state.activeTabType).toBe('editor')
    expect(state.activeFileId).toBe('file-1')
  })
})
