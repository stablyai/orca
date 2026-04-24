/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Tab, TabGroup } from '../../../../shared/types'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', () => ({
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

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
  }
}

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { createRepoSlice } from './repos'
import { createWorktreeSlice } from './worktrees'
import { createTerminalSlice } from './terminals'
import { createTabsSlice } from './tabs'
import { createUISlice } from './ui'
import { createSettingsSlice } from './settings'
import { createGitHubSlice } from './github'
import { createLinearSlice } from './linear'
import { createEditorSlice } from './editor'
import { createStatsSlice } from './stats'
import { createClaudeUsageSlice } from './claude-usage'
import { createCodexUsageSlice } from './codex-usage'
import { createBrowserSlice } from './browser'
import { createRateLimitSlice } from './rate-limits'
import { createSshSlice } from './ssh'
import { createAgentStatusSlice } from './agent-status'
import { createDiffCommentsSlice } from './diffComments'
import { createDetectedAgentsSlice } from './detected-agents'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'

const WT = 'repo1::/tmp/feature'

function createTestStore() {
  return create<AppState>()((...a) => ({
    ...createRepoSlice(...a),
    ...createWorktreeSlice(...a),
    ...createTerminalSlice(...a),
    ...createTabsSlice(...a),
    ...createUISlice(...a),
    ...createSettingsSlice(...a),
    ...createGitHubSlice(...a),
    ...createLinearSlice(...a),
    ...createEditorSlice(...a),
    ...createStatsSlice(...a),
    ...createClaudeUsageSlice(...a),
    ...createCodexUsageSlice(...a),
    ...createBrowserSlice(...a),
    ...createRateLimitSlice(...a),
    ...createSshSlice(...a),
    ...createAgentStatusSlice(...a),
    ...createDiffCommentsSlice(...a),
    ...createDetectedAgentsSlice(...a),
    ...createWorktreeNavHistorySlice(...a)
  }))
}

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
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

    it('reuses the existing group for the worktree', () => {
      store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'editor', { id: 'f.ts', label: 'f.ts' })

      expect(store.getState().groupsByWorktree[WT]).toHaveLength(1)
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

    it('activates the previously-active tab (MRU) instead of the visual neighbor', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      // Visit order: ...→t3 (last created)→t1→t3. Closing t3 should jump
      // back to t1 (previous), not t2 (the visual right-neighbor after t3's
      // removal fallback or left-neighbor).
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
      // Build state manually so no prior activations have been recorded. This
      // mirrors a freshly-hydrated session with only an active tab known.
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

      // Switch focus to the source group so subsequent activations in the
      // source group don't pollute the second group's MRU.
      store.getState().activateTab(t1.id)

      // Re-focus second group by activating t2, then close t2 — we expect the
      // previous tab within the same group (t3), not a neighbor from the
      // source group.
      store.getState().activateTab(t3.id)
      store.getState().activateTab(t2.id)
      store.getState().closeUnifiedTab(t2.id)

      const secondGroup = store.getState().groupsByWorktree[WT].find((g) => g.id === secondGroupId)
      expect(secondGroup?.activeTabId).toBe(t3.id)
      // Source group's active tab must remain untouched.
      const sourceGroup = store.getState().groupsByWorktree[WT].find((g) => g.id === sourceGroupId)
      expect(sourceGroup?.activeTabId).toBe(t1.id)
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
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)?.tabOrder
      ).toEqual([])
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

      const mergedInto = store.getState().mergeGroupIntoSibling(WT, targetGroupId!)

      expect(mergedInto).toBe(sourceGroupId)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([t1.id, 'file-b.ts'])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: sourceGroupId })
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
  })

  // ─── setTabLabel / setTabCustomLabel / setUnifiedTabColor ─────────

  describe('tab property setters', () => {
    it('setTabLabel updates the label', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabLabel(tab.id, 'zsh')
      expect(store.getState().unifiedTabsByWorktree[WT][0].label).toBe('zsh')
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

    it('unpins a tab', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().pinTab(tab.id)
      store.getState().unpinTab(tab.id)
      expect(store.getState().unifiedTabsByWorktree[WT][0].isPinned).toBe(false)
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
  })
})
