import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  createTestStore,
  makeLayout,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { buildOrphanTerminalCleanupPatch } from './terminal-orphan-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('publishes the first terminal and root tab group atomically', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const snapshots: { terminalCount: number; unifiedCount: number; groupCount: number }[] = []
    const unsubscribe = store.subscribe((state) => {
      snapshots.push({
        terminalCount: state.tabsByWorktree[wt]?.length ?? 0,
        unifiedCount: state.unifiedTabsByWorktree[wt]?.length ?? 0,
        groupCount: state.groupsByWorktree[wt]?.length ?? 0
      })
    })

    store.getState().createTab(wt)
    unsubscribe()

    // Why: a terminal-only intermediate state mounts the legacy host and races the split-group host, duplicating setup panes and PTYs.
    expect(snapshots).toEqual([{ terminalCount: 1, unifiedCount: 1, groupCount: 1 }])
  })

  it('syncs the global active surface when focusing a different split group', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const editorFileId = '/path/wt1/src/index.ts'
    const terminalGroupId = 'group-terminal'
    const editorGroupId = 'group-editor'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeFileId: editorFileId,
      activeFileIdByWorktree: { [wt]: editorFileId },
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      openFiles: [makeOpenFile({ id: editorFileId, worktreeId: wt, filePath: editorFileId })],
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId: terminalGroupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'editor-view-1',
            entityId: editorFileId,
            worktreeId: wt,
            groupId: editorGroupId,
            contentType: 'editor',
            label: 'src/index.ts'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: terminalGroupId,
            worktreeId: wt,
            activeTabId: terminalTabId,
            tabOrder: [terminalTabId]
          }),
          makeTabGroup({
            id: editorGroupId,
            worktreeId: wt,
            activeTabId: 'editor-view-1',
            tabOrder: ['editor-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: terminalGroupId },
          second: { type: 'leaf', groupId: editorGroupId }
        }
      },
      activeGroupIdByWorktree: { [wt]: terminalGroupId }
    })

    store.getState().focusGroup(wt, editorGroupId)

    const s = store.getState()
    expect(s.activeGroupIdByWorktree[wt]).toBe(editorGroupId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(editorFileId)
    expect(s.activeFileIdByWorktree[wt]).toBe(editorFileId)
    expect(s.activeTabId).toBe(terminalTabId)
  })

  it('promotes the next tab in the focused split into the global active surface on close', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const browserTabId = 'browser-1'
    const groupId = 'group-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'browser',
      activeBrowserTabId: browserTabId,
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'browser-view-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser',
            label: 'Example'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'browser-view-1',
            tabOrder: [terminalTabId, 'browser-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().closeBrowserTab(browserTabId)

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.[0]?.activeTabId).toBe(terminalTabId)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalTabId)
    expect(s.activeBrowserTabId).toBeNull()
    expect(s.activeBrowserTabIdByWorktree[wt]).toBeNull()
  })

  it('promotes the sibling group into the global active surface when closing a focused empty split', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const editorFileId = '/path/wt1/src/index.ts'
    const emptyGroupId = 'group-empty'
    const editorGroupId = 'group-editor'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      activeFileId: editorFileId,
      activeFileIdByWorktree: { [wt]: editorFileId },
      openFiles: [makeOpenFile({ id: editorFileId, worktreeId: wt, filePath: editorFileId })],
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'editor-view-1',
            entityId: editorFileId,
            worktreeId: wt,
            groupId: editorGroupId,
            contentType: 'editor',
            label: 'src/index.ts'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: emptyGroupId,
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          }),
          makeTabGroup({
            id: editorGroupId,
            worktreeId: wt,
            activeTabId: 'editor-view-1',
            tabOrder: ['editor-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: emptyGroupId },
          second: { type: 'leaf', groupId: editorGroupId }
        }
      },
      activeGroupIdByWorktree: { [wt]: emptyGroupId }
    })

    store.getState().closeEmptyGroup(wt, emptyGroupId)

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.map((group) => group.id)).toEqual([editorGroupId])
    expect(s.activeGroupIdByWorktree[wt]).toBe(editorGroupId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(editorFileId)
    expect(s.activeFileIdByWorktree[wt]).toBe(editorFileId)
  })

  it('reuses the lowest available terminal number after closes', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    const second = store.getState().createTab(wt)

    expect(first.title).toBe('Terminal 1')
    expect(second.title).toBe('Terminal 2')

    store.getState().closeTab(first.id)
    store.getState().closeTab(second.id)

    const replacement = store.getState().createTab(wt)
    expect(replacement.title).toBe('Terminal 1')
  })

  it('preserves cleanup-owned references when there are no orphan terminals', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'terminal-1',
            entityId: 'terminal-1',
            worktreeId: wt,
            groupId: 'group-1'
          })
        ]
      },
      ptyIdsByTabId: {
        'terminal-1': []
      },
      activeTabId: 'terminal-1',
      activeTabIdByWorktree: {
        [wt]: 'terminal-1'
      }
    })

    const state = store.getState()
    const patch = buildOrphanTerminalCleanupPatch(state, wt, new Set())
    const referenceKeys = [
      'tabsByWorktree',
      'ptyIdsByTabId',
      'runtimePaneTitlesByTabId',
      'expandedPaneByTabId',
      'canExpandPaneByTabId',
      'terminalLayoutsByTabId',
      'pendingStartupByTabId',
      'pendingInitialCwdByTabId',
      'pendingSetupSplitByTabId',
      'pendingIssueCommandSplitByTabId',
      'automaticAgentResumeClaimsByTabId',
      'tabBarOrderByWorktree',
      'cacheTimerByKey',
      'activeTabIdByWorktree'
    ] as const

    for (const key of referenceKeys) {
      expect(patch[key]).toBe(state[key])
    }
    expect(patch.activeTabId).toBe(state.activeTabId)
  })

  it('removes orphan terminal caches while creating a replacement tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: orphanId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: []
      },
      ptyIdsByTabId: {
        [orphanId]: []
      },
      runtimePaneTitlesByTabId: {
        [orphanId]: { 1: 'stale' }
      },
      terminalLayoutsByTabId: {
        [orphanId]: makeLayout()
      },
      pendingStartupByTabId: {
        [orphanId]: { command: 'codex' }
      },
      automaticAgentResumeClaimsByTabId: {
        [orphanId]: {
          worktreeId: wt,
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' }
        }
      },
      pendingInitialCwdByTabId: {
        [orphanId]: '/repo/packages/web'
      },
      tabBarOrderByWorktree: {
        [wt]: [orphanId]
      },
      cacheTimerByKey: {
        [`${orphanId}:seed`]: 123
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const replacement = store.getState().createTab(wt)
    const s = store.getState()

    expect(s.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([replacement.id])
    expect(s.ptyIdsByTabId[orphanId]).toBeUndefined()
    expect(s.runtimePaneTitlesByTabId[orphanId]).toBeUndefined()
    expect(s.terminalLayoutsByTabId[orphanId]).toBeUndefined()
    expect(s.pendingStartupByTabId[orphanId]).toBeUndefined()
    expect(s.automaticAgentResumeClaimsByTabId[orphanId]).toBeUndefined()
    expect(s.pendingInitialCwdByTabId[orphanId]).toBeUndefined()
    expect(s.cacheTimerByKey[`${orphanId}:seed`]).toBeUndefined()
    expect(s.terminalLayoutsByTabId[replacement.id]).toEqual(makeLayout())
  })

  it('clears orphan active terminal state while creating an inactive replacement tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: orphanId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: []
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId]
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: []
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const replacement = store.getState().createTab(wt, undefined, undefined, { activate: false })
    const s = store.getState()

    expect(s.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([replacement.id])
    expect(s.activeTabId).toBeNull()
    expect(s.activeTabIdByWorktree[wt]).toBe(replacement.id)
    expect(s.groupsByWorktree[wt]?.[0]?.activeTabId).toBe(replacement.id)
    expect(s.groupsByWorktree[wt]?.[0]?.tabOrder).toEqual([replacement.id])
  })

  it('uses cleanup active fallback when inactive creation removes an orphan active tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-a'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: existingId,
            tabOrder: [existingId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const s = store.getState()

    expect(s.activeTabId).toBeNull()
    expect(s.activeTabIdByWorktree[wt]).toBe(existingId)
    expect(s.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([existingId, created.id])
    expect(s.groupsByWorktree[wt]?.find((group) => group.id === 'group-b')).toMatchObject({
      activeTabId: created.id,
      tabOrder: [created.id]
    })
  })

  it('keeps surviving target-group tab active when inactive creation removes an orphan', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-1'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId, existingId],
            recentTabIds: [orphanId]
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const created = store.getState().createTab(wt, 'group-1', undefined, { activate: false })
    const s = store.getState()

    expect(s.activeTabIdByWorktree[wt]).toBe(existingId)
    expect(s.groupsByWorktree[wt]?.[0]).toMatchObject({
      activeTabId: existingId,
      tabOrder: [existingId, created.id],
      recentTabIds: [existingId]
    })
  })

  it('keeps inactive terminal creation active state scoped to the target group', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: existingId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-a'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: existingId,
            tabOrder: [existingId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [existingId]: []
      },
      activeTabId: existingId,
      activeTabIdByWorktree: {
        [wt]: existingId
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const groups = store.getState().groupsByWorktree[wt] ?? []

    expect(store.getState().activeTabIdByWorktree[wt]).toBe(existingId)
    expect(groups.find((group) => group.id === 'group-a')?.activeTabId).toBe(existingId)
    expect(groups.find((group) => group.id === 'group-b')?.activeTabId).toBe(created.id)
    expect(groups.find((group) => group.id === 'group-b')?.tabOrder).toEqual([created.id])
  })

  it('clears orphan terminal state from non-target groups during tab creation', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: orphanId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: []
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId],
            recentTabIds: [orphanId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: []
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const groups = store.getState().groupsByWorktree[wt] ?? []

    expect(groups.find((group) => group.id === 'group-a')).toMatchObject({
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    })
    expect(groups.find((group) => group.id === 'group-b')).toMatchObject({
      activeTabId: created.id,
      tabOrder: [created.id]
    })
  })

  it('keeps surviving non-target group tab active when inactive creation removes an orphan', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-a'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId, existingId],
            recentTabIds: [orphanId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const groups = store.getState().groupsByWorktree[wt] ?? []

    expect(groups.find((group) => group.id === 'group-a')).toMatchObject({
      activeTabId: existingId,
      tabOrder: [existingId],
      recentTabIds: [existingId]
    })
    expect(groups.find((group) => group.id === 'group-b')).toMatchObject({
      activeTabId: created.id,
      tabOrder: [created.id]
    })
  })
})
