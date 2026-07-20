/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/types'
import type * as AgentStatusModule from '@/lib/agent-status'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultUIState } from '../../../../shared/constants'
import { buildMobileSessionTabSnapshots } from '../../runtime/sync-runtime-graph'
import { closeMobileSessionTabInStore } from '../../runtime/mobile-session-tab-close'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockResolvedValue({ id: 'pty-1' })
  },
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  },
  ui: {
    set: vi.fn().mockResolvedValue(undefined)
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  },
  claudeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyClaudeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  },
  codexUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyCodexData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  },
  openCodeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyOpenCodeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  }
}

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { createTestStore, makeOpenFile, makeTabGroup, makeUnifiedTab } from './store-test-helpers'

const WT = 'repo1::/tmp/feature'

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  it('setRenamingTabId sets and clears the tab rename signal', () => {
    expect(store.getState().renamingTabId).toBeNull()
    store.getState().setRenamingTabId('terminal-tab-1')
    expect(store.getState().renamingTabId).toBe('terminal-tab-1')
    store.getState().setRenamingTabId(null)
    expect(store.getState().renamingTabId).toBeNull()
  })

  // ─── createUnifiedTab ───────────────────────────────────────────────

  describe('createUnifiedTab', () => {
    it('creates a terminal tab and auto-creates a group', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')

      expect(tab.contentType).toBe('terminal')
      expect(tab.worktreeId).toBe(WT)
      expect(tab.label).toMatch(/^Terminal/)

      const state = store.getState()
      expect(state.unifiedTabsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].activeTabId).toBe(tab.id)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([tab.id])
    })

    it('creates an editor tab with filePath as id', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: '/tmp/feature/src/main.ts',
        label: 'main.ts'
      })

      expect(tab.id).toBe('/tmp/feature/src/main.ts')
      expect(tab.contentType).toBe('editor')
      expect(tab.label).toBe('main.ts')
    })

    it('activates the newly created tab', () => {
      const tab1 = store.getState().createUnifiedTab(WT, 'terminal')
      const tab2 = store.getState().createUnifiedTab(WT, 'terminal')

      const group = store.getState().groupsByWorktree[WT][0]
      expect(group.activeTabId).toBe(tab2.id)
      expect(group.tabOrder).toEqual([tab1.id, tab2.id])
    })

    it('can create a tab without activating it', () => {
      const tab1 = store.getState().createUnifiedTab(WT, 'terminal')
      const tab2 = store.getState().createUnifiedTab(WT, 'browser', { activate: false })

      const group = store.getState().groupsByWorktree[WT][0]
      expect(group.activeTabId).toBe(tab1.id)
      expect(group.tabOrder).toEqual([tab1.id, tab2.id])
      expect(group.recentTabIds).toEqual([tab1.id])
    })

    it('replaces existing preview tab when creating a new preview', () => {
      const preview1 = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts',
        isPreview: true
      })
      store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-b.ts',
        label: 'file-b.ts',
        isPreview: true
      })

      const tabs = store.getState().unifiedTabsByWorktree[WT]
      expect(tabs).toHaveLength(1)
      expect(tabs[0].id).toBe('file-b.ts')

      const group = store.getState().groupsByWorktree[WT][0]
      expect(group.tabOrder).toEqual(['file-b.ts'])
      expect(group.tabOrder).not.toContain(preview1.id)
    })

    it('replaces editor preview tabs with diff preview tabs', () => {
      store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts',
        isPreview: true
      })
      store.getState().createUnifiedTab(WT, 'diff', {
        id: 'diff-file-b.ts',
        entityId: 'diff-file-b.ts',
        label: 'file-b.ts',
        isPreview: true
      })

      expect(store.getState().unifiedTabsByWorktree[WT]).toEqual([
        expect.objectContaining({
          id: 'diff-file-b.ts',
          contentType: 'diff',
          isPreview: true
        })
      ])
      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['diff-file-b.ts'])
    })

    it('reuses the existing group for the worktree', () => {
      store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'editor', { id: 'f.ts', label: 'f.ts' })

      expect(store.getState().groupsByWorktree[WT]).toHaveLength(1)
    })
  })

  describe('terminal tab creation tracking', () => {
    it('records normal terminal tab creation without recording activation fallback tabs', () => {
      const setMock = vi.mocked(window.api.ui.set)
      store.getState().hydratePersistedUI(getDefaultUIState())
      setMock.mockClear()

      store.getState().createTab(WT)
      store.getState().createTab(WT, undefined, undefined, { pendingActivationSpawn: true })

      expect(setMock).toHaveBeenCalledTimes(1)
      expect(setMock).toHaveBeenCalledWith({
        featureInteractions: {
          'terminal-tabs': expect.objectContaining({ interactionCount: 1 })
        }
      })
    })
  })

  // ─── closeUnifiedTab ────────────────────────────────────────────────

  describe('closeUnifiedTab', () => {
    it('removes the tab and selects right neighbor', () => {
      store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      // Activate t2 so closing it tests neighbor selection
      store.getState().activateTab(t2.id)

      const result = store.getState().closeUnifiedTab(t2.id)

      expect(result).toEqual({ closedTabId: t2.id, wasLastTab: false, worktreeId: WT })
      const state = store.getState()
      expect(state.unifiedTabsByWorktree[WT]).toHaveLength(2)
      // Right neighbor (t3) should be active
      expect(state.groupsByWorktree[WT][0].activeTabId).toBe(t3.id)
    })

    it('selects left neighbor when closing the rightmost tab', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      // t2 is already active (last created)

      const result = store.getState().closeUnifiedTab(t2.id)

      expect(result?.wasLastTab).toBe(false)
      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t1.id)
    })

    it('returns wasLastTab: true when closing the only tab', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')

      const result = store.getState().closeUnifiedTab(t1.id)

      expect(result?.wasLastTab).toBe(true)
      expect(store.getState().unifiedTabsByWorktree[WT]).toHaveLength(0)
      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBeNull()
    })

    it('does not change active tab when closing a non-active tab', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')
      // t3 is active

      store.getState().closeUnifiedTab(t1.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t3.id)
    })

    it('returns null for nonexistent tab', () => {
      const result = store.getState().closeUnifiedTab('nonexistent')
      expect(result).toBeNull()
    })

    it('removes a mobile-closed markdown tab from open files so it is not republished', () => {
      const groupId = 'editor-group'
      const file = makeOpenFile({
        id: '/tmp/feature/README.md',
        filePath: '/tmp/feature/README.md',
        relativePath: 'README.md',
        language: 'markdown',
        worktreeId: WT
      })
      const tab = makeUnifiedTab({
        id: 'readme-unified',
        entityId: file.id,
        contentType: 'editor',
        label: 'README.md',
        worktreeId: WT,
        groupId
      })
      store.setState({
        openFiles: [file],
        unifiedTabsByWorktree: { [WT]: [tab] },
        groupsByWorktree: {
          [WT]: [
            makeTabGroup({
              id: groupId,
              worktreeId: WT,
              activeTabId: tab.id,
              tabOrder: [tab.id],
              recentTabIds: [tab.id]
            })
          ]
        },
        activeGroupIdByWorktree: { [WT]: groupId },
        activeFileId: file.id,
        activeFileIdByWorktree: { [WT]: file.id },
        activeWorktreeId: WT,
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' }
      })

      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs).toMatchObject([
        { id: tab.id, type: 'markdown', filePath: file.filePath }
      ])

      expect(closeMobileSessionTabInStore(store.getState(), WT, tab.id)).toBe(true)

      expect(store.getState().openFiles).toEqual([])
      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs ?? []).toEqual([])
    })

    it('removes a mobile-closed regular file tab from open files so fallback closes do not resurrect', () => {
      const groupId = 'editor-group'
      const file = makeOpenFile({
        id: '/tmp/feature/src/app.ts',
        filePath: '/tmp/feature/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
        worktreeId: WT
      })
      const tab = makeUnifiedTab({
        id: 'app-unified',
        entityId: file.id,
        contentType: 'editor',
        label: 'app.ts',
        worktreeId: WT,
        groupId
      })
      store.setState({
        openFiles: [file],
        unifiedTabsByWorktree: { [WT]: [tab] },
        groupsByWorktree: {
          [WT]: [
            makeTabGroup({
              id: groupId,
              worktreeId: WT,
              activeTabId: tab.id,
              tabOrder: [tab.id],
              recentTabIds: [tab.id]
            })
          ]
        },
        activeGroupIdByWorktree: { [WT]: groupId },
        activeFileId: file.id,
        activeFileIdByWorktree: { [WT]: file.id },
        activeWorktreeId: WT,
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' }
      })

      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs).toMatchObject([
        { id: tab.id, type: 'file', filePath: file.filePath }
      ])

      expect(closeMobileSessionTabInStore(store.getState(), WT, tab.id)).toBe(true)

      expect(store.getState().openFiles).toEqual([])
      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs ?? []).toEqual([])
    })

    it('closes a mobile fallback file-id tab after the unified wrapper is already gone', () => {
      const file = makeOpenFile({
        id: '/tmp/feature/src/app.ts',
        filePath: '/tmp/feature/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
        worktreeId: WT
      })
      store.setState({
        openFiles: [file],
        unifiedTabsByWorktree: { [WT]: [] },
        groupsByWorktree: { [WT]: [] },
        activeFileId: file.id,
        activeFileIdByWorktree: { [WT]: file.id },
        activeWorktreeId: WT,
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' }
      })

      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs).toMatchObject([
        { id: file.id, type: 'file', filePath: file.filePath }
      ])

      expect(closeMobileSessionTabInStore(store.getState(), WT, file.id)).toBe(true)

      expect(store.getState().openFiles).toEqual([])
      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs ?? []).toEqual([])
    })

    it('activates the previously-active tab (MRU) instead of the visual neighbor', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      // Visit order ...→t3→t1→t3; closing t3 should jump to t1 (MRU previous), not the visual neighbor t2.
      store.getState().activateTab(t1.id)
      store.getState().activateTab(t3.id)
      store.getState().closeUnifiedTab(t3.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t1.id)
      // t2 should still exist and not be active
      expect(
        store
          .getState()
          .unifiedTabsByWorktree[WT].map((t) => t.id)
          .sort()
      ).toEqual([t1.id, t2.id].sort())
    })

    it('falls back to neighbor selection when the MRU stack has no prior tab', () => {
      // Build state manually (no prior activations) — mirrors a freshly-hydrated session with only an active tab known.
      const groupId = 'mru-fallback-group'
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'a',
              entityId: 'a',
              groupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'a',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'b',
              entityId: 'b',
              groupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'b',
              customLabel: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            },
            {
              id: 'c',
              entityId: 'c',
              groupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'c',
              customLabel: null,
              color: null,
              sortOrder: 2,
              createdAt: 3
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: groupId,
              worktreeId: WT,
              activeTabId: 'b',
              tabOrder: ['a', 'b', 'c'],
              recentTabIds: ['b']
            }
          ]
        },
        activeGroupIdByWorktree: { [WT]: groupId }
      })

      store.getState().closeUnifiedTab('b')

      // MRU only contains 'b' itself, so fallback picks the right neighbor 'c'.
      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe('c')
    })

    it('tracks an independent MRU history per tab group', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const secondGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(secondGroupId).toBeTruthy()

      // Create two tabs in the second (right) group and visit them in order.
      const t2 = store.getState().createUnifiedTab(WT, 'terminal', {
        targetGroupId: secondGroupId!
      })
      const t3 = store.getState().createUnifiedTab(WT, 'terminal', {
        targetGroupId: secondGroupId!
      })
      // Second group's MRU tail should be t3.

      // Focus the source group so its activations don't pollute the second group's MRU.
      store.getState().activateTab(t1.id)

      // Re-focus the second group via t2, then close it: expect the same-group previous tab (t3), not a source-group neighbor.
      store.getState().activateTab(t3.id)
      store.getState().activateTab(t2.id)
      store.getState().closeUnifiedTab(t2.id)

      const secondGroup = store.getState().groupsByWorktree[WT].find((g) => g.id === secondGroupId)
      expect(secondGroup?.activeTabId).toBe(t3.id)
      // Source group's active tab must remain untouched.
      const sourceGroup = store.getState().groupsByWorktree[WT].find((g) => g.id === sourceGroupId)
      expect(sourceGroup?.activeTabId).toBe(t1.id)
    })

    it('records generic pane interaction when creating an empty split group', () => {
      const setMock = vi.mocked(window.api.ui.set)
      store.getState().hydratePersistedUI(getDefaultUIState())
      setMock.mockClear()
      store.getState().createUnifiedTab(WT, 'terminal')
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

      store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')

      expect(store.getState().featureInteractions['terminal-pane-split']).toBeUndefined()
      expect(store.getState().featureInteractions['terminal-panes']).toMatchObject({
        interactionCount: 1
      })
    })
  })

  // ─── activateTab ──────────────────────────────────────────────────

  describe('activateTab', () => {
    it('sets the active tab on the group', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().activateTab(t1.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t1.id)
    })

    it('promotes a preview tab to permanent on activation', () => {
      const preview = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'f.ts',
        label: 'f.ts',
        isPreview: true
      })

      expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(true)

      store.getState().activateTab(preview.id)

      expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(false)
    })

    // Why (regression): activateTab gets a *unified* tabId but the bell is keyed by entityId, so it must resolve entityId or the bell won't clear on click.
    it('clears unreadTerminalTabs for a terminal tab when its unified tab activates', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      // t2 is active after creation; move focus to t1 so we can mark t2 unread.
      store.getState().activateTab(t1.id)

      // Mark WT active: activateTab's unread-clear is guarded on activeWorktreeId so hidden-worktree activations don't swallow the signal.
      store.setState({ activeWorktreeId: WT })

      // entityId is the terminal tabId that markTerminalTabUnread / TabBar read from.
      const t2TerminalId = t2.entityId
      store.setState({
        unreadTerminalTabs: {
          ...store.getState().unreadTerminalTabs,
          [t2TerminalId]: true as const
        }
      })
      expect(store.getState().unreadTerminalTabs[t2TerminalId]).toBe(true)

      store.getState().activateTab(t2.id)

      expect(store.getState().unreadTerminalTabs[t2TerminalId]).toBeUndefined()
    })
  })

  // Ghostty "show until interact": BEL always marks unread (even focused/visible tabs); only user interaction via clearTerminalTabUnread dismisses it.
  describe('markTerminalTabUnread', () => {
    it('marks the tab even when it is active in a visible split group of the active worktree', () => {
      // Group A: the worktree's root group (implicit from createUnifiedTab), populated with tabA.
      const tabA = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id

      // Group B: split right of A, populate + focus it so tabA is visible-but-not-focused.
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })
      store.getState().focusGroup(WT, groupBId)
      store.setState({ activeWorktreeId: WT })

      // Seed the backing legacy terminal tab so the owner-missing guard doesn't short-circuit.
      store.setState({
        tabsByWorktree: {
          [WT]: [
            {
              id: tabA.entityId,
              ptyId: null,
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: Date.now()
            }
          ]
        }
      })

      // Fire a bell on Group A's visible tab: under ghostty semantics the indicator still appears — only clearTerminalTabUnread dismisses it.
      store.getState().markTerminalTabUnread(tabA.entityId)

      expect(store.getState().unreadTerminalTabs[tabA.entityId]).toBe(true)
    })

    it('does mark a tab that is not the active tab of any visible group', () => {
      // Group A with two terminal tabs. Activate tabA1, leaving tabA2 inactive.
      const tabA1 = store.getState().createUnifiedTab(WT, 'terminal')
      const tabA2 = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id
      store.getState().activateTab(tabA1.id)

      // Split Group B to the right with its own tab (two visible groups, matching the split-group condition); focus it.
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })
      store.getState().focusGroup(WT, groupBId)
      store.setState({ activeWorktreeId: WT })
      // Why: markTerminalTabUnread skips tabs missing from tabsByWorktree, so seed the backing legacy tab that every terminal unified tab has in production.
      store.setState({
        tabsByWorktree: {
          [WT]: [
            {
              id: tabA2.entityId,
              ptyId: null,
              worktreeId: WT,
              title: 'Terminal 2',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: Date.now()
            }
          ]
        }
      })

      // tabA2 is NOT the active tab of any group — a bell on it is legitimate.
      store.getState().markTerminalTabUnread(tabA2.entityId)

      expect(store.getState().unreadTerminalTabs[tabA2.entityId]).toBe(true)
    })

    // Why: under show-until-interact, BEL fires unconditionally even on a non-terminal/offscreen surface — a legitimate unread.
    it('still marks the tab when the active surface is not terminal', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      // Point active* at this tab but mark a different worktree active (skips the visible-groups check); only activeTabType='editor' remains as a guard.
      // Why: seed tabsByWorktree — markTerminalTabUnread guards against a missing owner tab.
      store.setState({
        activeWorktreeId: 'other-wt::/path/x',
        activeTabId: tab.entityId,
        activeTabType: 'editor',
        tabsByWorktree: {
          [WT]: [
            {
              id: tab.entityId,
              ptyId: null,
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: Date.now()
            }
          ]
        }
      })

      store.getState().markTerminalTabUnread(tab.entityId)

      expect(store.getState().unreadTerminalTabs[tab.entityId]).toBe(true)
    })

    it('is a no-op when the tab is already flagged', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      // Why: seed tabsByWorktree so the owner-missing guard doesn't short-circuit before we reach the "already flagged" branch.
      store.setState({
        unreadTerminalTabs: { [tab.entityId]: true as const },
        activeTabId: 'something-else',
        activeTabType: 'terminal',
        activeWorktreeId: 'other-wt',
        tabsByWorktree: {
          [WT]: [
            {
              id: tab.entityId,
              ptyId: null,
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: Date.now()
            }
          ]
        }
      })
      const before = store.getState().unreadTerminalTabs

      store.getState().markTerminalTabUnread(tab.entityId)

      // Same object reference => no state mutation occurred.
      expect(store.getState().unreadTerminalTabs).toBe(before)
    })

    // Why: markTerminalTabUnread is agent-agnostic — blocking the working→idle dot here would swallow the agent's completion signal.
    it('marks unread for an agent tab when it is not focused', () => {
      const agentTabId = 'agent-tab-1'
      store.setState({
        activeTabId: 'something-else',
        activeTabType: 'terminal',
        activeWorktreeId: 'other-wt',
        tabsByWorktree: {
          [WT]: [
            {
              id: agentTabId,
              ptyId: null,
              worktreeId: WT,
              title: '* Claude done',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: Date.now()
            }
          ]
        }
      })

      store.getState().markTerminalTabUnread(agentTabId)

      expect(store.getState().unreadTerminalTabs[agentTabId]).toBe(true)
    })
  })

  // Called on real user interaction (xterm onData keystroke or pointerdown) — the dismissal half of show-until-interact.
  describe('clearTerminalTabUnread', () => {
    it('removes the tab from unreadTerminalTabs', () => {
      const tabId = 'bell-tab-1'
      store.setState({
        unreadTerminalTabs: { [tabId]: true as const, 'other-tab': true as const }
      })

      store.getState().clearTerminalTabUnread(tabId)

      expect(store.getState().unreadTerminalTabs).toEqual({ 'other-tab': true })
    })

    it('is a reference-preserving no-op when the tab is not flagged', () => {
      const initial = { 'other-tab': true as const }
      store.setState({ unreadTerminalTabs: initial })

      store.getState().clearTerminalTabUnread('bell-tab-1')

      // Same reference => no-op. Downstream selectors must not re-render.
      expect(store.getState().unreadTerminalTabs).toBe(initial)
    })
  })

  // Regression guard: clicking a group whose tab is already active (no activateTab) must still dismiss the bell, else it lingers until a second click.
  describe('focusGroup', () => {
    it('does not broadcast active-surface writes when the focused group is already current', () => {
      const editorFileId = '/tmp/feature/src/main.ts'
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'editor-tab-1',
        entityId: editorFileId,
        label: 'main.ts'
      })
      const groupId = store.getState().groupsByWorktree[WT][0].id
      store.setState({
        activeWorktreeId: WT,
        openFiles: [makeOpenFile({ id: editorFileId, worktreeId: WT })],
        activeGroupIdByWorktree: { [WT]: groupId },
        activeFileId: editorFileId,
        activeFileIdByWorktree: { [WT]: editorFileId },
        activeBrowserTabId: null,
        activeBrowserTabIdByWorktree: { [WT]: null },
        activeTabId: null,
        activeTabIdByWorktree: { [WT]: null },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        groupsByWorktree: {
          [WT]: [
            {
              ...store.getState().groupsByWorktree[WT][0],
              activeTabId: tab.id
            }
          ]
        }
      })
      const before = store.getState()
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)

      store.getState().focusGroup(WT, groupId)
      unsubscribe()

      expect(listener).not.toHaveBeenCalled()
      expect(store.getState().activeGroupIdByWorktree).toBe(before.activeGroupIdByWorktree)
      expect(store.getState().activeFileIdByWorktree).toBe(before.activeFileIdByWorktree)
      expect(store.getState().activeTabTypeByWorktree).toBe(before.activeTabTypeByWorktree)
    })

    // Why: focusGroup fires on every pointerdown in the group chrome, so clearing the tab-level bell here is safe — the user is now viewing it.
    it("clears the tab-level bell on the focused group's active tab", () => {
      const tabA = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })
      // Focus Group B first so the active group is not A.
      store.getState().focusGroup(WT, groupBId)

      // Mark WT active: focusGroup's unread-clear is guarded on activeWorktreeId to avoid swallowing bells in hidden worktrees.
      store.setState({
        unreadTerminalTabs: { [tabA.entityId]: true as const },
        activeWorktreeId: WT
      })

      // Clicking Group A's chrome re-focuses it without calling activateTab (active tab unchanged).
      store.getState().focusGroup(WT, groupAId)

      // Tab-level bell cleared — the user is now viewing this tab.
      expect(store.getState().unreadTerminalTabs[tabA.entityId]).toBeUndefined()
    })

    it('clears unread on every visible terminal tab across split groups', () => {
      const tabA = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      const tabB = store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })

      store.setState({
        unreadTerminalTabs: {
          [tabA.entityId]: true as const,
          [tabB.entityId]: true as const
        },
        activeWorktreeId: WT
      })

      // Why: both groups' active tabs are visible in a split, so neither keeps a stale unread bell once focused.
      store.getState().focusGroup(WT, groupAId)

      expect(store.getState().unreadTerminalTabs[tabA.entityId]).toBeUndefined()
      expect(store.getState().unreadTerminalTabs[tabB.entityId]).toBeUndefined()
    })
  })

  // ─── reorderUnifiedTabs ───────────────────────────────────────────

  describe('reorderUnifiedTabs', () => {
    it('updates tabOrder on the group and sortOrder on tabs', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      const groupId = store.getState().groupsByWorktree[WT][0].id
      store.getState().reorderUnifiedTabs(groupId, [t3.id, t1.id, t2.id])

      const group = store.getState().groupsByWorktree[WT][0]
      expect(group.tabOrder).toEqual([t3.id, t1.id, t2.id])

      const tabs = store.getState().unifiedTabsByWorktree[WT]
      const sorted = [...tabs].sort((a, b) => a.sortOrder - b.sortOrder)
      expect(sorted.map((t) => t.id)).toEqual([t3.id, t1.id, t2.id])
    })
  })

  describe('setTabGroupSplitRatio', () => {
    it('updates the persisted ratio for the targeted split node', () => {
      store.setState({
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', groupId: 'g-1' },
            second: {
              type: 'split',
              direction: 'vertical',
              ratio: 0.5,
              first: { type: 'leaf', groupId: 'g-2' },
              second: { type: 'leaf', groupId: 'g-3' }
            }
          }
        }
      })

      store.getState().setTabGroupSplitRatio(WT, 'second', 0.7)

      const layout = store.getState().layoutByWorktree[WT]
      expect(layout.type).toBe('split')
      if (layout.type !== 'split' || layout.second.type !== 'split') {
        throw new Error('expected nested split layout')
      }
      expect(layout.ratio).toBe(0.5)
      expect(layout.second.ratio).toBe(0.7)
    })
  })

  describe('move/copy/merge group operations', () => {
    it('moves a unified tab into another group', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()

      store.getState().moveUnifiedTabToGroup(tab.id, targetGroupId!)

      const state = store.getState()
      const moved = state.unifiedTabsByWorktree[WT].find((item) => item.id === tab.id)
      expect(moved?.groupId).toBe(targetGroupId)
      expect(state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)).toBeUndefined()
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === targetGroupId)?.tabOrder
      ).toEqual([tab.id])
    })

    it('copies a unified tab into another group', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()

      const copied = store.getState().copyUnifiedTabToGroup(tab.id, targetGroupId!)

      expect(copied).not.toBeNull()
      const state = store.getState()
      expect(state.unifiedTabsByWorktree[WT]).toHaveLength(2)
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)?.tabOrder
      ).toEqual([tab.id])
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === targetGroupId)?.tabOrder
      ).toEqual([copied!.id])
      expect(copied?.entityId).toBe(tab.entityId)
    })

    it('merges a group into its sibling', () => {
      const setMock = vi.mocked(window.api.ui.set)
      const t1 = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()
      store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-b.ts',
        label: 'file-b.ts',
        targetGroupId: targetGroupId!
      })
      store.getState().hydratePersistedUI(getDefaultUIState())
      setMock.mockClear()

      const mergedInto = store.getState().mergeGroupIntoSibling(WT, targetGroupId!)

      expect(mergedInto).toBe(sourceGroupId)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([t1.id, 'file-b.ts'])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: sourceGroupId })
      expect(setMock).toHaveBeenCalledTimes(1)
      expect(setMock).toHaveBeenCalledWith({
        featureInteractions: {
          'terminal-panes': expect.objectContaining({ interactionCount: 1 })
        }
      })
    })

    it('drops a unified tab into another group and collapses an emptied source group', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()

      const moved = store.getState().dropUnifiedTab(tab.id, { groupId: targetGroupId! })

      expect(moved).toBe(true)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].id).toBe(targetGroupId)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([tab.id])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: targetGroupId })
      expect(state.activeGroupIdByWorktree[WT]).toBe(targetGroupId)
    })

    it('drops a unified tab onto a pane edge to create a sibling split', () => {
      const first = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const second = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-b.ts',
        label: 'file-b.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

      const moved = store.getState().dropUnifiedTab(second.id, {
        groupId: sourceGroupId,
        splitDirection: 'right'
      })

      expect(moved).toBe(true)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(2)

      const originGroup = state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)
      expect(originGroup?.tabOrder).toEqual([first.id])

      const movedTab = state.unifiedTabsByWorktree[WT].find((tab) => tab.id === second.id)
      const newGroupId = movedTab?.groupId
      expect(newGroupId).toBeTruthy()
      expect(newGroupId).not.toBe(sourceGroupId)
      expect(state.groupsByWorktree[WT].find((group) => group.id === newGroupId)?.tabOrder).toEqual(
        [second.id]
      )

      const layout = state.layoutByWorktree[WT]
      expect(layout.type).toBe('split')
      if (layout.type !== 'split') {
        throw new Error('expected split layout after edge drop')
      }
      expect(layout.direction).toBe('horizontal')
      expect(layout.first).toEqual({ type: 'leaf', groupId: sourceGroupId })
      expect(layout.second).toEqual({ type: 'leaf', groupId: newGroupId })
    })

    it('creates a unified tab directly in a sibling split without publishing a source-group midpoint', () => {
      const terminal = store.getState().createUnifiedTab(WT, 'terminal', {
        id: 'terminal-1',
        label: 'Terminal 1'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      store.setState({ activeWorktreeId: WT })
      const publishedSimulatorGroupIds: (string | null)[] = []
      const unsubscribe = store.subscribe((state) => {
        publishedSimulatorGroupIds.push(
          state.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'simulator')
            ?.groupId ?? null
        )
      })

      const simulator = store.getState().createUnifiedTabInSplit(
        WT,
        'simulator',
        {
          sourceGroupId,
          splitDirection: 'right'
        },
        {
          id: 'simulator-1',
          label: 'Mobile Emulator'
        }
      )
      unsubscribe()

      expect(simulator).not.toBeNull()
      expect(publishedSimulatorGroupIds).not.toContain(sourceGroupId)
      const state = store.getState()
      const simulatorGroupId = simulator!.groupId
      expect(state.activeWorktreeId).toBe(WT)
      expect(state.activeTabType).toBe('simulator')
      expect(state.activeGroupIdByWorktree[WT]).toBe(simulatorGroupId)
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)?.tabOrder
      ).toEqual([terminal.id])
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === simulatorGroupId)?.tabOrder
      ).toEqual([simulator!.id])
      const layout = state.layoutByWorktree[WT]
      expect(layout.type).toBe('split')
      if (layout.type !== 'split') {
        throw new Error('expected split layout after split tab creation')
      }
      expect(layout.direction).toBe('horizontal')
      expect(layout.first).toEqual({ type: 'leaf', groupId: sourceGroupId })
      expect(layout.second).toEqual({ type: 'leaf', groupId: simulatorGroupId })
    })

    it('creates a split tab without stealing focus when activation is disabled', () => {
      store.getState().createUnifiedTab(WT, 'terminal', {
        id: 'terminal-1',
        label: 'Terminal 1'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      store.setState({ activeWorktreeId: WT })

      const simulator = store.getState().createUnifiedTabInSplit(
        WT,
        'simulator',
        {
          sourceGroupId,
          splitDirection: 'right'
        },
        {
          id: 'simulator-1',
          label: 'Mobile Emulator',
          activate: false
        }
      )

      expect(simulator).not.toBeNull()
      const state = store.getState()
      expect(state.activeGroupIdByWorktree[WT]).toBe(sourceGroupId)
      expect(state.activeTabType).toBe('terminal')
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === simulator!.groupId)?.recentTabIds
      ).toEqual([])
    })

    it('treats splitting the only tab onto its own pane body as a no-op', () => {
      const onlyTab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

      const moved = store.getState().dropUnifiedTab(onlyTab.id, {
        groupId: sourceGroupId,
        splitDirection: 'down'
      })

      expect(moved).toBe(false)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([onlyTab.id])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: sourceGroupId })
    })

    it('treats splitting the only tab onto the adjacent sibling edge as a no-op', () => {
      store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const right = store.getState().createUnifiedTab(WT, 'terminal', {
        id: 'terminal-1',
        label: 'Terminal 1'
      })
      const leftGroupId = store.getState().groupsByWorktree[WT][0].id

      expect(
        store.getState().dropUnifiedTab(right.id, {
          groupId: leftGroupId,
          splitDirection: 'right'
        })
      ).toBe(true)

      const rightGroupId = store
        .getState()
        .unifiedTabsByWorktree[WT].find((tab) => tab.id === right.id)?.groupId
      expect(rightGroupId).toBeTruthy()

      const moved = store.getState().dropUnifiedTab(right.id, {
        groupId: leftGroupId,
        splitDirection: 'right'
      })

      expect(moved).toBe(false)
      expect(
        store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === right.id)?.groupId
      ).toBe(rightGroupId)
    })
  })

  // ─── setTabLabel / setTabCustomLabel / setUnifiedTabColor ─────────

  describe('tab property setters', () => {
    it('setTabLabel updates the label', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabLabel(tab.id, 'zsh')
      expect(store.getState().unifiedTabsByWorktree[WT][0].label).toBe('zsh')
    })

    it('setTabLabel preserves tab map references when the label is unchanged', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabLabel(tab.id, 'zsh')
      const before = store.getState().unifiedTabsByWorktree

      store.getState().setTabLabel(tab.id, 'zsh')

      expect(store.getState().unifiedTabsByWorktree).toBe(before)
    })

    it('setTabCustomLabel updates customLabel', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabCustomLabel(tab.id, 'my-term')
      expect(store.getState().unifiedTabsByWorktree[WT][0].customLabel).toBe('my-term')
    })

    it('setTabCustomLabel clears customLabel with null', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabCustomLabel(tab.id, 'my-term')
      store.getState().setTabCustomLabel(tab.id, null)
      expect(store.getState().unifiedTabsByWorktree[WT][0].customLabel).toBeNull()
    })

    it('setUnifiedTabColor updates color', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setUnifiedTabColor(tab.id, '#ff0000')
      expect(store.getState().unifiedTabsByWorktree[WT][0].color).toBe('#ff0000')
    })
  })

  // ─── pinTab / unpinTab ────────────────────────────────────────────

  describe('pinTab / unpinTab', () => {
    it('pins a tab and promotes preview to permanent', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'f.ts',
        label: 'f.ts',
        isPreview: true
      })

      store.getState().pinTab(tab.id)

      const updated = store.getState().unifiedTabsByWorktree[WT][0]
      expect(updated.isPinned).toBe(true)
      expect(updated.isPreview).toBe(false)
    })

    it('moves pinned tabs before unpinned siblings', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().pinTab(t3.id)
      store.getState().pinTab(t2.id)

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([t3.id, t2.id, t1.id])
      expect(store.getState().unifiedTabsByWorktree[WT].map((tab) => tab.sortOrder)).toEqual([
        2, 1, 0
      ])
    })

    it('unpins a tab', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().pinTab(tab.id)
      store.getState().unpinTab(tab.id)
      expect(store.getState().unifiedTabsByWorktree[WT][0].isPinned).toBe(false)
    })

    it('keeps remaining pinned tabs before a tab that was unpinned', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().pinTab(t2.id)
      store.getState().pinTab(t3.id)

      store.getState().unpinTab(t2.id)

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([t3.id, t2.id, t1.id])
    })

    it('syncs isPinned to the TerminalTab in tabsByWorktree (reconcile echo guard)', () => {
      // Why: reconcile derives pin from tabsByWorktree[*].isPinned; without syncing, a host snapshot re-computes isPinned:false and un-pins during the echo window.
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [WT]: [
            {
              id: tab.id,
              ptyId: null,
              worktreeId: WT,
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }))

      store.getState().pinTab(tab.id)
      expect(store.getState().tabsByWorktree[WT][0].isPinned).toBe(true)

      store.getState().unpinTab(tab.id)
      expect(store.getState().tabsByWorktree[WT][0].isPinned).toBe(false)
    })
  })

  // ─── closeOtherTabs ───────────────────────────────────────────────

  describe('closeOtherTabs', () => {
    it('closes all tabs except the target and pinned tabs', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().pinTab(t1.id)

      const closed = store.getState().closeOtherTabs(t2.id)

      expect(closed).toEqual([t3.id])
      const tabs = store.getState().unifiedTabsByWorktree[WT]
      expect(tabs).toHaveLength(2)
      expect(tabs.map((t) => t.id)).toContain(t1.id) // pinned
      expect(tabs.map((t) => t.id)).toContain(t2.id) // target
    })

    it('activates the target tab', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().closeOtherTabs(t1.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t1.id)
    })

    it('returns empty when nothing to close', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const closed = store.getState().closeOtherTabs(t1.id)
      expect(closed).toEqual([])
    })
  })

  // ─── closeTabsToRight ─────────────────────────────────────────────

  describe('closeTabsToRight', () => {
    it('closes unpinned tabs to the right of target', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')
      const t4 = store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().pinTab(t3.id)

      const closed = store.getState().closeTabsToRight(t1.id)

      expect(closed).toEqual([t2.id, t4.id])
      const tabs = store.getState().unifiedTabsByWorktree[WT]
      expect(tabs.map((t) => t.id)).toEqual([t1.id, t3.id])
    })

    it('activates target if active tab was closed', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'terminal')
      // last created tab is active

      store.getState().closeTabsToRight(t1.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t1.id)
    })
  })

  // ─── getActiveTab / getTab ────────────────────────────────────────

  describe('getActiveTab / getTab', () => {
    it('getActiveTab returns the active tab for a worktree', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'editor', { id: 'f.ts', label: 'f.ts' })

      store.getState().activateTab(t1.id)

      expect(store.getState().getActiveTab(WT)?.id).toBe(t1.id)
    })

    it('getActiveTab returns null for worktree with no tabs', () => {
      expect(store.getState().getActiveTab(WT)).toBeNull()
    })

    it('getTab finds a tab by id across worktrees', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      expect(store.getState().getTab(tab.id)?.id).toBe(tab.id)
    })

    it('getTab returns null for unknown id', () => {
      expect(store.getState().getTab('unknown')).toBeNull()
    })
  })

  // ─── hydrateTabsSession ───────────────────────────────────────────

  describe('hydrateTabsSession', () => {
    it('hydrates from legacy format (TerminalTab[] + PersistedOpenFile[])', () => {
      // Seed with a valid worktree
      store.setState({
        worktreesByRepo: {
          repo1: [
            {
              id: WT,
              repoId: 'repo1',
              path: '/tmp/feature',
              head: 'abc',
              branch: 'feature',
              isBare: false,
              isMainWorktree: false,
              displayName: 'feature',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              linkedGitLabMR: null,
              linkedGitLabIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          ]
        }
      })

      store.getState().hydrateTabsSession({
        activeRepoId: 'repo1',
        activeWorktreeId: WT,
        activeTabId: 'term-1',
        tabsByWorktree: {
          [WT]: [
            {
              id: 'term-1',
              ptyId: null,
              worktreeId: WT,
              title: 'zsh',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1000
            },
            {
              id: 'term-2',
              ptyId: null,
              worktreeId: WT,
              title: 'node',
              customTitle: 'dev',
              color: '#f00',
              sortOrder: 1,
              createdAt: 2000
            }
          ]
        },
        terminalLayoutsByTabId: {},
        openFilesByWorktree: {
          [WT]: [
            {
              filePath: '/tmp/feature/src/main.ts',
              relativePath: 'src/main.ts',
              worktreeId: WT,
              language: 'typescript'
            }
          ]
        },
        activeFileIdByWorktree: { [WT]: '/tmp/feature/src/main.ts' },
        activeTabTypeByWorktree: { [WT]: 'terminal' }
      })

      const state = store.getState()
      const tabs = state.unifiedTabsByWorktree[WT]
      expect(tabs).toHaveLength(3) // 2 terminals + 1 editor

      const terminal1 = tabs.find((t) => t.id === 'term-1')
      expect(terminal1?.contentType).toBe('terminal')
      expect(terminal1?.label).toBe('zsh')

      const terminal2 = tabs.find((t) => t.id === 'term-2')
      expect(terminal2?.customLabel).toBe('dev')
      expect(terminal2?.color).toBe('#f00')

      const editor = tabs.find((t) => t.id === '/tmp/feature/src/main.ts')
      expect(editor?.contentType).toBe('editor')
      expect(editor?.label).toBe('src/main.ts')

      // Group should exist with correct active tab
      const groups = state.groupsByWorktree[WT]
      expect(groups).toHaveLength(1)
      expect(groups[0].activeTabId).toBe('term-1')
      expect(groups[0].tabOrder).toEqual(['term-1', 'term-2', '/tmp/feature/src/main.ts'])
    })

    it('hydrates floating workspace unified tabs without a repo worktree', () => {
      store.getState().hydrateTabsSession({
        activeRepoId: null,
        activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-browser-1',
              entityId: 'floating-browser-1',
              groupId: 'floating-group-1',
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              contentType: 'browser',
              label: 'Browser',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        tabGroups: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-group-1',
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              activeTabId: 'floating-browser-1',
              tabOrder: ['floating-browser-1']
            }
          ]
        }
      })

      expect(store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    })

    it('hydrates from unified format', () => {
      store.setState({
        worktreesByRepo: {
          repo1: [
            {
              id: WT,
              repoId: 'repo1',
              path: '/tmp/feature',
              head: 'abc',
              branch: 'feature',
              isBare: false,
              isMainWorktree: false,
              displayName: 'feature',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              linkedGitLabMR: null,
              linkedGitLabIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          ]
        }
      })

      const groupId = 'g-1'
      const tabs: Tab[] = [
        {
          id: 't-1',
          entityId: 't-1',
          groupId,
          worktreeId: WT,
          contentType: 'terminal',
          label: 'zsh',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1000
        },
        {
          id: '/file.ts',
          entityId: '/file.ts',
          groupId,
          worktreeId: WT,
          contentType: 'editor',
          label: 'file.ts',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 2000
        }
      ]
      const groups: TabGroup[] = [
        { id: groupId, worktreeId: WT, activeTabId: '/file.ts', tabOrder: ['t-1', '/file.ts'] }
      ]

      store.getState().hydrateTabsSession({
        activeRepoId: 'repo1',
        activeWorktreeId: WT,
        activeTabId: 't-1',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: { [WT]: tabs },
        tabGroups: { [WT]: groups }
      })

      const state = store.getState()
      expect(state.unifiedTabsByWorktree[WT]).toHaveLength(2)
      expect(state.groupsByWorktree[WT][0].activeTabId).toBe('/file.ts')
    })

    it('deduplicates persisted tab order during unified hydration', () => {
      store.setState({
        worktreesByRepo: {
          repo1: [
            {
              id: WT,
              repoId: 'repo1',
              path: '/tmp/feature',
              head: 'abc',
              branch: 'feature',
              isBare: false,
              isMainWorktree: false,
              displayName: 'feature',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              linkedGitLabMR: null,
              linkedGitLabIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          ]
        }
      })

      const groupId = 'g-1'
      const tabs: Tab[] = [
        {
          id: 't-1',
          entityId: 't-1',
          groupId,
          worktreeId: WT,
          contentType: 'terminal',
          label: 'zsh',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1000
        },
        {
          id: '/file.ts',
          entityId: '/file.ts',
          groupId,
          worktreeId: WT,
          contentType: 'editor',
          label: 'file.ts',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 2000
        }
      ]
      const groups: TabGroup[] = [
        {
          id: groupId,
          worktreeId: WT,
          activeTabId: '/file.ts',
          tabOrder: ['t-1', 't-1', '/file.ts', '/file.ts']
        }
      ]

      store.getState().hydrateTabsSession({
        activeRepoId: 'repo1',
        activeWorktreeId: WT,
        activeTabId: 't-1',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: { [WT]: tabs },
        tabGroups: { [WT]: groups }
      })

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['t-1', '/file.ts'])
    })

    it('filters out invalid worktree IDs during hydration', () => {
      store.setState({ worktreesByRepo: {} })

      store.getState().hydrateTabsSession({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {
          'nonexistent-wt': [
            {
              id: 't-1',
              ptyId: null,
              worktreeId: 'nonexistent-wt',
              title: 'zsh',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1000
            }
          ]
        },
        terminalLayoutsByTabId: {}
      })

      expect(store.getState().unifiedTabsByWorktree).toEqual({})
    })
  })

  // ─── Cross-content-type neighbor selection ────────────────────────

  describe('cross-content-type neighbor selection', () => {
    it('selects an editor tab as neighbor when closing a terminal tab', () => {
      const term = store.getState().createUnifiedTab(WT, 'terminal')
      const editor = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file.ts',
        label: 'file.ts'
      })

      // Activate the terminal tab, then close it
      store.getState().activateTab(term.id)
      store.getState().closeUnifiedTab(term.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(editor.id)
    })

    it('selects a terminal tab as neighbor when closing an editor tab', () => {
      const term = store.getState().createUnifiedTab(WT, 'terminal')
      const editor = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file.ts',
        label: 'file.ts'
      })

      // editor is active (last created), close it
      store.getState().closeUnifiedTab(editor.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(term.id)
    })
  })

  describe('tabOrder dedupe', () => {
    it('deduplicates drag reorder payloads before persisting group order', () => {
      const first = store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'terminal')

      const groupId = store.getState().groupsByWorktree[WT][0].id
      store.getState().reorderUnifiedTabs(groupId, [second.id, first.id, second.id, first.id])

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([second.id, first.id])
    })
  })

  describe('reconcileWorktreeTabModel', () => {
    it('drops unified tabs whose backing content no longer exists', () => {
      const groupId = 'g-1'
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'stale-terminal',
              entityId: 'stale-terminal',
              groupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: groupId,
              worktreeId: WT,
              activeTabId: 'stale-terminal',
              tabOrder: ['stale-terminal']
            }
          ]
        },
        activeGroupIdByWorktree: { [WT]: groupId },
        tabsByWorktree: { [WT]: [] }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)

      expect(result.renderableTabCount).toBe(0)
      expect(result.activeRenderableTabId).toBeNull()
      expect(store.getState().unifiedTabsByWorktree[WT]).toEqual([])
      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([])
      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBeNull()
    })

    it('keeps simulator tabs because they reconnect their own backing stream', () => {
      const terminalGroupId = 'g-terminal'
      const simulatorGroupId = 'g-simulator'
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              entityId: 'terminal-1',
              groupId: terminalGroupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'simulator-1',
              entityId: 'simulator-1',
              groupId: simulatorGroupId,
              worktreeId: WT,
              contentType: 'simulator',
              label: 'iPhone 17 Pro',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 2
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: terminalGroupId,
              worktreeId: WT,
              activeTabId: 'terminal-1',
              tabOrder: ['terminal-1']
            },
            {
              id: simulatorGroupId,
              worktreeId: WT,
              activeTabId: 'simulator-1',
              tabOrder: ['simulator-1']
            }
          ]
        },
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: terminalGroupId },
            second: { type: 'leaf', groupId: simulatorGroupId }
          }
        },
        activeGroupIdByWorktree: { [WT]: simulatorGroupId },
        tabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              ptyId: 'pty-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { 'terminal-1': ['pty-1'] }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const state = store.getState()

      expect(result.renderableTabCount).toBe(2)
      expect(result.activeRenderableTabId).toBe('simulator-1')
      expect(state.unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual([
        'terminal-1',
        'simulator-1'
      ])
      expect(state.groupsByWorktree[WT].map((group) => group.tabOrder)).toEqual([
        ['terminal-1'],
        ['simulator-1']
      ])
      expect(state.layoutByWorktree[WT]).toEqual({
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: terminalGroupId },
        second: { type: 'leaf', groupId: simulatorGroupId }
      })
    })

    it('collapses empty split groups when reconciliation drops a stale tab', () => {
      const terminalGroupId = 'g-terminal'
      const staleGroupId = 'g-stale'
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              entityId: 'terminal-1',
              groupId: terminalGroupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'stale-browser',
              entityId: 'missing-browser',
              groupId: staleGroupId,
              worktreeId: WT,
              contentType: 'browser',
              label: 'Missing browser',
              customLabel: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: terminalGroupId,
              worktreeId: WT,
              activeTabId: 'terminal-1',
              tabOrder: ['terminal-1']
            },
            {
              id: staleGroupId,
              worktreeId: WT,
              activeTabId: 'stale-browser',
              tabOrder: ['stale-browser']
            }
          ]
        },
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: terminalGroupId },
            second: { type: 'leaf', groupId: staleGroupId }
          }
        },
        activeGroupIdByWorktree: { [WT]: staleGroupId },
        tabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              ptyId: 'pty-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { 'terminal-1': ['pty-1'] },
        browserTabsByWorktree: { [WT]: [] }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const state = store.getState()

      expect(result.renderableTabCount).toBe(1)
      expect(result.activeRenderableTabId).toBe('terminal-1')
      expect(state.groupsByWorktree[WT]).toEqual([
        expect.objectContaining({ id: terminalGroupId, tabOrder: ['terminal-1'] })
      ])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: terminalGroupId })
      expect(state.activeGroupIdByWorktree[WT]).toBe(terminalGroupId)
    })

    it('restores live runtime terminal tabs into the unified tab model', () => {
      const runtimeTerminalId = 'runtime-terminal-1'

      store.setState({
        tabsByWorktree: {
          [WT]: [
            {
              id: runtimeTerminalId,
              ptyId: 'pty-4',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: {
          [runtimeTerminalId]: ['pty-4']
        },
        unifiedTabsByWorktree: {
          [WT]: []
        },
        groupsByWorktree: {
          [WT]: []
        },
        activeGroupIdByWorktree: {}
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const state = store.getState()
      const restoredTab = state.unifiedTabsByWorktree[WT]?.[0]
      const restoredGroup = state.groupsByWorktree[WT]?.[0]

      expect(result.renderableTabCount).toBe(1)
      expect(result.activeRenderableTabId).toBe(runtimeTerminalId)
      expect(restoredTab).toMatchObject({
        id: runtimeTerminalId,
        entityId: runtimeTerminalId,
        contentType: 'terminal',
        label: 'Terminal 1'
      })
      expect(restoredGroup).toMatchObject({
        activeTabId: runtimeTerminalId,
        tabOrder: [runtimeTerminalId]
      })
      expect(state.layoutByWorktree[WT]).toEqual({
        type: 'leaf',
        groupId: restoredGroup?.id
      })
    })

    it('promotes legacy terminals to the worktree remembered tab, not always the first one', () => {
      // Why (regression): reconcile seeded the group with restoredLegacyTabs[0], dropping the remembered selection so it always reopened Terminal 1.
      const firstTerminalId = 'runtime-terminal-1'
      const secondTerminalId = 'runtime-terminal-2'

      store.setState({
        tabsByWorktree: {
          [WT]: [
            {
              id: firstTerminalId,
              ptyId: 'pty-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: secondTerminalId,
              ptyId: 'pty-2',
              worktreeId: WT,
              title: 'Terminal 2',
              customTitle: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        ptyIdsByTabId: {
          [firstTerminalId]: ['pty-1'],
          [secondTerminalId]: ['pty-2']
        },
        unifiedTabsByWorktree: { [WT]: [] },
        groupsByWorktree: { [WT]: [] },
        activeGroupIdByWorktree: {},
        // The user had Terminal 2 active before leaving this worktree.
        activeTabIdByWorktree: { [WT]: secondTerminalId }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const restoredGroup = store.getState().groupsByWorktree[WT]?.[0]

      expect(result.renderableTabCount).toBe(2)
      expect(result.activeRenderableTabId).toBe(secondTerminalId)
      expect(restoredGroup?.activeTabId).toBe(secondTerminalId)
    })

    it('keeps a sole terminal renderable after its PTY exits so a failed direnv does not strand the worktree', () => {
      // Why (regression): a promoted terminal whose PTY dies must stay renderable, not orphan and bounce to Landing.
      const tab = store
        .getState()
        .createTab(WT, undefined, undefined, { pendingActivationSpawn: true })
      store.getState().updateTabPtyId(tab.id, 'pty-died')
      // First reconcile promotes the legacy runtime tab into the unified model.
      expect(store.getState().reconcileWorktreeTabModel(WT).renderableTabCount).toBe(1)

      // The newborn PTY exits: pty-connection clears the binding but keeps the pane.
      store.getState().clearTabPtyId(tab.id, 'pty-died')
      const clearedTab = store.getState().tabsByWorktree[WT]?.find((t) => t.id === tab.id)
      expect(store.getState().ptyIdsByTabId[tab.id] ?? []).toEqual([])
      expect(clearedTab?.ptyId ?? null).toBeNull()

      const result = store.getState().reconcileWorktreeTabModel(WT)
      expect(result.renderableTabCount).toBe(1)
      expect(result.activeRenderableTabId).toBe(tab.id)
    })
  })
})
