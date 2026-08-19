import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultUIState } from '../../../../shared/constants'
import { buildMobileSessionTabSnapshots } from '../../runtime/sync-runtime-graph'
import { closeMobileSessionTabInStore } from '../../runtime/mobile-session-tab-close'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeOpenFile, makeTabGroup, makeUnifiedTab } from './store-test-helpers'

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

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

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

  // ─── closeTabsToLeft ──────────────────────────────────────────────

  describe('closeTabsToLeft', () => {
    it('closes unpinned tabs to the left of target', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')
      const t4 = store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().pinTab(t2.id)

      const closed = store.getState().closeTabsToLeft(t4.id)

      expect(closed).toEqual([t1.id, t3.id])
      const tabs = store.getState().unifiedTabsByWorktree[WT]
      expect(tabs.map((t) => t.id)).toEqual([t2.id, t4.id])
    })

    it('returns empty when target is the leftmost tab', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'terminal')

      const closed = store.getState().closeTabsToLeft(t1.id)

      expect(closed).toEqual([])
      expect(store.getState().unifiedTabsByWorktree[WT]).toHaveLength(2)
    })

    it('activates target if active tab was closed', () => {
      store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().activateTab(t2.id)

      store.getState().closeTabsToLeft(t3.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t3.id)
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
})
