import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveAutoAckTabTargets } from '@/hooks/agent-auto-ack-targets'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeOpenFile } from './store-test-helpers'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  describe('activateTab', () => {
    it('sets the active tab on the group', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().activateTab(t1.id)

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t1.id)
    })

    it('promotes a preview tab to permanent on activation', async () => {
      store.setState({ openFiles: [makeOpenFile({ id: 'f.ts', worktreeId: WT, isPreview: true })] })
      const preview = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'f.ts',
        label: 'f.ts',
        isPreview: true
      })
      const main = await drawTabsFromMain(store)
      try {
        expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(true)

        store.getState().activateTab(preview.id)
        // A layout-owner build: main promotes it, and only its frame ends the preview.
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(true)
          expect(layoutApplyTestTransport.sentOfType('promotePreviewTab')).toEqual([
            { type: 'promotePreviewTab', workspace: WT, tabId: preview.id }
          ])
        }
        await main.settle()

        expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(
          ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : false
        )
      } finally {
        main.close()
      }
    })

    // Unified activation IDs differ from entity-keyed bell markers; on-screen read must use entityId.
    it('puts the terminal tab on screen by entityId and leaves its marker to the on-screen read', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      // t2 is active after creation; move focus to t1 so we can mark t2 unread.
      store.getState().activateTab(t1.id)

      store.setState({ activeWorktreeId: WT, activeView: 'terminal' })

      // entityId is the terminal tabId that markTerminalBell / TabBar read from.
      const t2TerminalId = t2.entityId
      store.setState({
        unreadTerminalTabs: {
          ...store.getState().unreadTerminalTabs,
          [t2TerminalId]: true as const
        }
      })
      expect(store.getState().unreadTerminalTabs[t2TerminalId]).toBe(true)

      store.getState().activateTab(t2.id)

      expect(store.getState().unreadTerminalTabs[t2TerminalId]).toBe(true)
      expect(resolveAutoAckTabTargets(store.getState())).toEqual([
        { tabId: t2TerminalId, worktreeId: WT, surfaceKind: 'terminal' }
      ])
    })
  })

  // Ghostty "show until interact": BEL always marks unread (even focused/visible tabs); the on-screen read dismisses it.
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

  describe('markTerminalBell tab marker', () => {
    it('marks the tab even when it is active in a visible split group of the active worktree', () => {
      const tabA = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id

      // Split/focus group B so group A’s tab is visible but unfocused.
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

      // Visible unfocused tabs still get BEL markers; only pane input dismisses them.
      store
        .getState()
        .markTerminalBell({ worktreeId: WT, tabId: tabA.entityId, paneKey: `${tabA.entityId}:0` })

      expect(store.getState().unreadTerminalTabs[tabA.entityId]).toBe('terminal-bell')
    })

    it('does mark a tab that is not the active tab of any visible group', () => {
      const tabA1 = store.getState().createUnifiedTab(WT, 'terminal')
      const tabA2 = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id
      store.getState().activateTab(tabA1.id)

      // Create/focus group B to exercise bells with two visible groups.
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })
      store.getState().focusGroup(WT, groupBId)
      store.setState({ activeWorktreeId: WT })
      // Bell marking requires backing legacy terminal rows, as every production terminal has.
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

      store
        .getState()
        .markTerminalBell({ worktreeId: WT, tabId: tabA2.entityId, paneKey: `${tabA2.entityId}:0` })

      expect(store.getState().unreadTerminalTabs[tabA2.entityId]).toBe('terminal-bell')
    })

    // Why: under show-until-interact, BEL fires unconditionally even on a non-terminal/offscreen surface — a legitimate unread.
    it('still marks the tab when the active surface is not terminal', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      // Point active* at this tab but mark a different worktree active (skips the visible-groups check); only activeTabType='editor' remains as a guard.
      // Why: seed tabsByWorktree — the tab marker guards against a missing owner tab.
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

      store
        .getState()
        .markTerminalBell({ worktreeId: WT, tabId: tab.entityId, paneKey: `${tab.entityId}:0` })

      expect(store.getState().unreadTerminalTabs[tab.entityId]).toBe('terminal-bell')
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

      store
        .getState()
        .markTerminalBell({ worktreeId: WT, tabId: tab.entityId, paneKey: `${tab.entityId}:0` })

      // Same object reference => no state mutation occurred.
      expect(store.getState().unreadTerminalTabs).toBe(before)
    })

    // Why: the bell's tab marker is agent-agnostic — blocking the working→idle dot here would swallow the agent's completion signal.
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

      store
        .getState()
        .markTerminalBell({ worktreeId: WT, tabId: agentTabId, paneKey: `${agentTabId}:0` })

      expect(store.getState().unreadTerminalTabs[agentTabId]).toBe('terminal-bell')
    })
  })

  // The on-screen scan's read of a visible tab.
  describe('readOnScreenAttention tab marker', () => {
    it('removes the tab from unreadTerminalTabs', () => {
      const tabId = 'bell-tab-1'
      store.setState({
        unreadTerminalTabs: { [tabId]: true as const, 'other-tab': true as const }
      })

      store
        .getState()
        .readOnScreenAttention(
          { workspaceIds: [WT], targets: [{ worktreeId: WT, tabId }] },
          { screenArrived: false }
        )

      expect(store.getState().unreadTerminalTabs).toEqual({ 'other-tab': true })
    })

    it('is a reference-preserving no-op when the tab is not flagged', () => {
      const initial = { 'other-tab': true as const }
      store.setState({ unreadTerminalTabs: initial })

      store
        .getState()
        .readOnScreenAttention(
          { workspaceIds: [WT], targets: [{ worktreeId: WT, tabId: 'bell-tab-1' }] },
          { screenArrived: false }
        )

      expect(store.getState().unreadTerminalTabs).toBe(initial)
    })
  })

  // Already-active group clicks skip activateTab; focusGroup must still expose its tab to the attention scan.
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

    // Why: focusGroup fires on every pointerdown in the group chrome; it moves what is on screen and the scan reads it.
    it("puts the focused group's active tab on screen", () => {
      const tabA = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      const tabB = store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })
      store.getState().focusGroup(WT, groupBId)

      store.setState({
        unreadTerminalTabs: { [tabA.entityId]: true as const },
        activeWorktreeId: WT,
        activeView: 'terminal'
      })

      // Clicking Group A's chrome re-focuses it without calling activateTab (active tab unchanged).
      store.getState().focusGroup(WT, groupAId)

      expect(resolveAutoAckTabTargets(store.getState())[0]).toEqual({
        tabId: tabA.entityId,
        worktreeId: WT,
        surfaceKind: 'terminal'
      })
      expect(resolveAutoAckTabTargets(store.getState())).toContainEqual({
        tabId: tabB.entityId,
        worktreeId: WT,
        surfaceKind: 'terminal'
      })
    })

    it('puts the active tab of every side-by-side group on screen', () => {
      const tabA = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      const tabB = store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })
      store.setState({ activeWorktreeId: WT, activeView: 'terminal' })

      store.getState().focusGroup(WT, groupAId)

      expect(resolveAutoAckTabTargets(store.getState())).toEqual([
        { tabId: tabA.entityId, worktreeId: WT, surfaceKind: 'terminal' },
        { tabId: tabB.entityId, worktreeId: WT, surfaceKind: 'terminal' }
      ])
    })
  })
})
