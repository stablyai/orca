import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeOpenFile } from './store-test-helpers'

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
  describe('lastFocusedAt', () => {
    it('stamps a newly created tab that activates', () => {
      const before = Date.now()
      const tab = store.getState().createUnifiedTab(WT, 'terminal')

      const stored = store.getState().unifiedTabsByWorktree[WT].find((t) => t.id === tab.id)
      expect(stored?.lastFocusedAt).toBeGreaterThanOrEqual(before)
    })

    it('leaves a background-created tab unstamped', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal', { activate: false })

      const stored = store.getState().unifiedTabsByWorktree[WT].find((t) => t.id === tab.id)
      expect(stored?.lastFocusedAt).toBeUndefined()
    })

    it('stamps a tab created into a new split group', () => {
      const source = store.getState().createUnifiedTab(WT, 'terminal')
      const before = Date.now()
      const split = store.getState().createUnifiedTabInSplit(WT, 'terminal', {
        sourceGroupId: source.groupId,
        splitDirection: 'right'
      })

      const stored = store.getState().unifiedTabsByWorktree[WT].find((t) => t.id === split?.id)
      expect(stored?.lastFocusedAt).toBeGreaterThanOrEqual(before)
    })
  })

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
})
