import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorkspacePaneNode } from '../../../../shared/types'
import {
  MAX_WORKSPACE_SPLIT_PANES,
  collectPaneIds,
  enforceExclusiveWorkspaceSplitMembership,
  pruneWorkspaceSplitLayout,
  replaceWorkspacePaneLeaf,
  selectVisibleWorkspacePaneIds,
  workspaceSplitContainsPane
} from './workspace-split-view'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Why: setActiveWorktree fans out to GitHub refresh / settings IPC; the
// reconciliation tests only care about store state, so stub the preload api.
const mockApi = {
  worktrees: { list: vi.fn().mockResolvedValue([]), updateMeta: vi.fn().mockResolvedValue({}) },
  gh: { prForBranch: vi.fn().mockResolvedValue(null), issue: vi.fn().mockResolvedValue(null) },
  settings: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockResolvedValue({ id: 'p' })
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}
// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeWorktree, TEST_REPO } from './store-test-helpers'

const WT = (n: number): string => `${TEST_REPO.id}::/repo1/wt${n}`

function seedWorktrees(store: ReturnType<typeof createTestStore>, count: number): void {
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: Array.from({ length: count }, (_, i) =>
        makeWorktree({ id: WT(i + 1), repoId: TEST_REPO.id, path: `/repo1/wt${i + 1}` })
      )
    },
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalSideBySideWorkspaces: true
    }
  })
}

function setFlag(store: ReturnType<typeof createTestStore>, enabled: boolean): void {
  store.setState({
    settings: { ...getDefaultSettings('/tmp'), experimentalSideBySideWorkspaces: enabled }
  })
}

describe('workspace-split-view slice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    seedWorktrees(store, 8)
    store.setState({ activeWorktreeId: WT(1) })
  })

  it('opens a pane to the right of the active worktree', () => {
    expect(store.getState().openWorkspacePane(WT(2))).toBe(true)
    const layout = store.getState().workspaceSplitLayout
    expect(layout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'pane', worktreeId: WT(1) },
      second: { type: 'pane', worktreeId: WT(2) },
      ratio: 0.5
    })
  })

  it('opens on the requested edge relative to a target pane', () => {
    store.getState().openWorkspacePane(WT(2))
    expect(
      store.getState().openWorkspacePane(WT(3), { targetWorktreeId: WT(2), edge: 'down' })
    ).toBe(true)
    const layout = store.getState().workspaceSplitLayout
    expect(collectPaneIds(layout!)).toEqual([WT(1), WT(2), WT(3)])
    expect(layout).toMatchObject({
      second: { type: 'split', direction: 'vertical' }
    })
  })

  it('no-ops when the flag is off', () => {
    setFlag(store, false)
    expect(store.getState().openWorkspacePane(WT(2))).toBe(false)
    expect(store.getState().workspaceSplitLayout).toBeNull()
  })

  it('rejects unknown worktrees, self-splits, and already-visible worktrees', () => {
    expect(store.getState().openWorkspacePane('repoX::/nope')).toBe(false)
    expect(store.getState().openWorkspacePane(WT(1))).toBe(false)
    store.getState().openWorkspacePane(WT(2))
    expect(store.getState().openWorkspacePane(WT(2))).toBe(false)
  })

  it('enforces the pane cap', () => {
    for (let i = 2; i <= MAX_WORKSPACE_SPLIT_PANES; i++) {
      expect(store.getState().openWorkspacePane(WT(i))).toBe(true)
    }
    expect(store.getState().openWorkspacePane(WT(MAX_WORKSPACE_SPLIT_PANES + 1))).toBe(false)
    expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toHaveLength(
      MAX_WORKSPACE_SPLIT_PANES
    )
  })

  it('replace edge swaps a visible pane project without changing the tree shape', () => {
    store.getState().openWorkspacePane(WT(2))
    expect(
      store.getState().openWorkspacePane(WT(3), { targetWorktreeId: WT(2), edge: 'replace' })
    ).toBe(true)
    expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(1), WT(3)])
  })

  it('closeWorkspacePane merges the sibling up and collapses below 2 leaves', () => {
    store.getState().openWorkspacePane(WT(2))
    store.getState().openWorkspacePane(WT(3), { targetWorktreeId: WT(2), edge: 'down' })
    store.getState().closeWorkspacePane(WT(2))
    expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(1), WT(3)])
    store.getState().closeWorkspacePane(WT(3))
    expect(store.getState().workspaceSplitLayout).toBeNull()
  })

  it('clamps split ratios', () => {
    store.getState().openWorkspacePane(WT(2))
    store.getState().setWorkspaceSplitRatio([], 0.05)
    expect(
      (store.getState().workspaceSplitLayout as Extract<WorkspacePaneNode, { type: 'split' }>).ratio
    ).toBe(0.2)
    store.getState().setWorkspaceSplitRatio([], 0.95)
    expect(
      (store.getState().workspaceSplitLayout as Extract<WorkspacePaneNode, { type: 'split' }>).ratio
    ).toBe(0.8)
  })

  it('removeWorktreesFromSplitView prunes leaves even when the flag is off', () => {
    store.getState().openWorkspacePane(WT(2))
    setFlag(store, false)
    store.getState().removeWorktreesFromSplitView([WT(2)])
    expect(store.getState().workspaceSplitLayout).toBeNull()
  })

  describe('setActiveWorktree reconciliation (split associations)', () => {
    it('activating an unrelated worktree leaves the split behind as a saved association', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(3))
      expect(store.getState().workspaceSplitLayout).toBeNull()
      expect(store.getState().activeWorktreeId).toBe(WT(3))
      expect(Object.keys(store.getState().workspaceSplitLayoutsByAnchor)).toEqual([WT(1)])
    })

    it('activating a member of a saved split restores it', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(3))
      store.getState().setActiveWorktree(WT(2))
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(1), WT(2)])
      expect(store.getState().activeWorktreeId).toBe(WT(2))
    })

    it('pairing a member elsewhere steals it — the old split dissolves', () => {
      // WT(2) pairs with WT(1); dragging it next to WT(3) must remove it from
      // the WT(1) pairing, leaving WT(1) alone.
      store.getState().openWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(3))
      store.getState().openWorkspacePane(WT(2))
      expect(Object.keys(store.getState().workspaceSplitLayoutsByAnchor)).toEqual([WT(3)])
      store.getState().setActiveWorktree(WT(1))
      expect(store.getState().workspaceSplitLayout).toBeNull()
      store.getState().setActiveWorktree(WT(2))
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(3), WT(2)])
    })

    it('stealing from a 3-pane split keeps the survivors paired', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().openWorkspacePane(WT(4))
      store.getState().setActiveWorktree(WT(3))
      store.getState().openWorkspacePane(WT(2))
      expect(collectPaneIds(store.getState().workspaceSplitLayoutsByAnchor[WT(1)])).toEqual([
        WT(1),
        WT(4)
      ])
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(3), WT(2)])
    })

    it('keeps the layout unchanged when activating an already-visible pane', () => {
      store.getState().openWorkspacePane(WT(2))
      const before = store.getState().workspaceSplitLayout
      store.getState().setActiveWorktree(WT(2))
      expect(store.getState().workspaceSplitLayout).toBe(before)
      expect(store.getState().activeWorktreeId).toBe(WT(2))
    })

    it('clears the on-screen layout but keeps saved splits when active is cleared', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().setActiveWorktree(null)
      expect(store.getState().workspaceSplitLayout).toBeNull()
      expect(Object.keys(store.getState().workspaceSplitLayoutsByAnchor)).toEqual([WT(1)])
    })
  })

  describe('closeWorkspacePane (send back)', () => {
    it('dissolves a two-pane split and drops the saved association', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().closeWorkspacePane(WT(2))
      expect(store.getState().workspaceSplitLayout).toBeNull()
      expect(store.getState().workspaceSplitLayoutsByAnchor).toEqual({})
      // The dissolved pair no longer reopens together.
      store.getState().setActiveWorktree(WT(2))
      expect(store.getState().workspaceSplitLayout).toBeNull()
    })

    it('refocuses a surviving pane when the focused pane is closed', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(2))
      store.getState().closeWorkspacePane(WT(2))
      expect(store.getState().activeWorktreeId).toBe(WT(1))
      expect(store.getState().workspaceSplitLayout).toBeNull()
    })
  })

  describe('emptied pane collapse', () => {
    it('closing the focused pane last tab hands focus to the surviving pane', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(2))
      const tab = store.getState().createUnifiedTab(WT(2), 'editor')
      store.getState().closeUnifiedTab(tab.id)
      expect(store.getState().workspaceSplitLayout).toBeNull()
      expect(store.getState().activeWorktreeId).toBe(WT(1))
    })
  })

  describe('maximize / restore', () => {
    it('maximizes only members of the active split and focuses the pane', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().maximizeWorkspacePane(WT(3))
      expect(store.getState().workspaceSplitMaximizedPaneId).toBeNull()
      store.getState().maximizeWorkspacePane(WT(2))
      expect(store.getState().workspaceSplitMaximizedPaneId).toBe(WT(2))
      expect(store.getState().activeWorktreeId).toBe(WT(2))
      store.getState().restoreWorkspaceSplitPanes()
      expect(store.getState().workspaceSplitMaximizedPaneId).toBeNull()
    })

    it('clicking another member restores the grid', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().maximizeWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(1))
      expect(store.getState().workspaceSplitMaximizedPaneId).toBeNull()
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(1), WT(2)])
    })

    it('re-clicking the maximized pane keeps it maximized', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().maximizeWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(2))
      expect(store.getState().workspaceSplitMaximizedPaneId).toBe(WT(2))
    })

    it('adding or closing a pane restores the grid', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().maximizeWorkspacePane(WT(2))
      store.getState().openWorkspacePane(WT(3))
      expect(store.getState().workspaceSplitMaximizedPaneId).toBeNull()
      store.getState().maximizeWorkspacePane(WT(3))
      store.getState().closeWorkspacePane(WT(3))
      expect(store.getState().workspaceSplitMaximizedPaneId).toBeNull()
    })

    it('purging the maximized (focused) worktree clears the maximize and view', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().openWorkspacePane(WT(3))
      store.getState().maximizeWorkspacePane(WT(3))
      store.getState().purgeWorktreeTerminalState([WT(3)])
      expect(store.getState().workspaceSplitMaximizedPaneId).toBeNull()
      // Purging the focused pane clears the on-screen split (no focused pane
      // may render); the pruned {1,2} pairing stays saved and restorable.
      expect(store.getState().workspaceSplitLayout).toBeNull()
      store.getState().setActiveWorktree(WT(1))
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(1), WT(2)])
    })
  })

  describe('anchor-key integrity', () => {
    it('closing the anchor pane re-keys the split so a new pairing cannot clobber it', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().openWorkspacePane(WT(3))
      // Close the anchor (WT1) itself — focus hands to a survivor and the
      // {3,2} split must re-key away from WT1.
      store.getState().closeWorkspacePane(WT(1))
      expect(store.getState().activeWorktreeId).toBe(WT(3))
      store.getState().setActiveWorktree(WT(4))
      // Standalone on WT1 again, mint a fresh pairing under WT1's id.
      store.getState().setActiveWorktree(WT(1))
      expect(store.getState().workspaceSplitLayout).toBeNull()
      store.getState().openWorkspacePane(WT(5))
      // The unrelated {3,2} association must have survived under its new key.
      store.getState().setActiveWorktree(WT(2))
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(3), WT(2)])
    })

    it('replace-edge on the anchor pane re-keys instead of leaving a stale key', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().openWorkspacePane(WT(3), { targetWorktreeId: WT(1), edge: 'replace' })
      const anchors = Object.keys(store.getState().workspaceSplitLayoutsByAnchor)
      expect(anchors).toHaveLength(1)
      const layout = store.getState().workspaceSplitLayoutsByAnchor[anchors[0]]
      expect(collectPaneIds(layout)).toContain(anchors[0])
    })
  })

  describe('emptied non-focused pane', () => {
    it('closes the pane even when it is not the focused one', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().setActiveWorktree(WT(2))
      const tab = store.getState().createUnifiedTab(WT(2), 'editor')
      // Focus moves back to WT(1); the WT(2) pane then empties in background.
      store.getState().setActiveWorktree(WT(1))
      store.getState().closeUnifiedTab(tab.id)
      expect(store.getState().workspaceSplitLayout).toBeNull()
      expect(store.getState().activeWorktreeId).toBe(WT(1))
    })
  })

  describe('purge path', () => {
    it('purgeWorktreeTerminalState drops removed panes and collapses', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().purgeWorktreeTerminalState([WT(2)])
      expect(store.getState().workspaceSplitLayout).toBeNull()
    })

    it('purging the focused pane clears the on-screen split but keeps saved survivors', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().openWorkspacePane(WT(3))
      store.getState().purgeWorktreeTerminalState([WT(1)])
      expect(store.getState().activeWorktreeId).toBeNull()
      expect(store.getState().workspaceSplitLayout).toBeNull()
      expect(store.getState().activeWorkspaceSplitAnchorId).toBeNull()
      // The surviving {3,2} pairing is still saved and restorable.
      store.getState().setActiveWorktree(WT(2))
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(3), WT(2)])
    })

    it('keeps unrelated splits intact on purge', () => {
      store.getState().openWorkspacePane(WT(2))
      store.getState().openWorkspacePane(WT(3))
      store.getState().purgeWorktreeTerminalState([WT(2)])
      expect(collectPaneIds(store.getState().workspaceSplitLayout!)).toEqual([WT(1), WT(3)])
    })
  })
})

describe('workspace-split-view pure functions', () => {
  const tree: WorkspacePaneNode = {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'pane', worktreeId: 'a' },
    second: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'pane', worktreeId: 'b' },
      second: { type: 'pane', worktreeId: 'c' }
    }
  }

  it('collectPaneIds returns leaves left-to-right', () => {
    expect(collectPaneIds(tree)).toEqual(['a', 'b', 'c'])
  })

  it('workspaceSplitContainsPane and replaceWorkspacePaneLeaf work on nested trees', () => {
    expect(workspaceSplitContainsPane(tree, 'c')).toBe(true)
    expect(workspaceSplitContainsPane(tree, 'z')).toBe(false)
    expect(collectPaneIds(replaceWorkspacePaneLeaf(tree, 'b', 'z'))).toEqual(['a', 'z', 'c'])
  })

  it('pruneWorkspaceSplitLayout returns same reference when untouched', () => {
    expect(pruneWorkspaceSplitLayout(tree, new Set(['zzz']))).toBe(tree)
    expect(collectPaneIds(pruneWorkspaceSplitLayout(tree, new Set(['b']))!)).toEqual(['a', 'c'])
    expect(pruneWorkspaceSplitLayout(tree, new Set(['a', 'b', 'c']))).toBeNull()
  })

  it('enforceExclusiveWorkspaceSplitMembership keeps the MRU pairing only', () => {
    const byAnchor: Record<string, WorkspacePaneNode> = {
      old: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'pane', worktreeId: 'climb' },
        second: { type: 'pane', worktreeId: 'shared' }
      },
      recent: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'pane', worktreeId: 'lrq' },
        second: { type: 'pane', worktreeId: 'shared' }
      }
    }
    const result = enforceExclusiveWorkspaceSplitMembership(byAnchor, ['recent', 'old'])
    expect(Object.keys(result.byAnchor)).toEqual(['recent'])
    expect(result.mru).toEqual(['recent'])
    expect(collectPaneIds(result.byAnchor.recent)).toEqual(['lrq', 'shared'])
  })

  it('selectVisibleWorkspacePaneIds falls back to the active worktree', () => {
    expect(
      selectVisibleWorkspacePaneIds({ activeWorktreeId: 'a', workspaceSplitLayout: null })
    ).toEqual(['a'])
    expect(
      selectVisibleWorkspacePaneIds({ activeWorktreeId: null, workspaceSplitLayout: null })
    ).toEqual([])
    expect(
      selectVisibleWorkspacePaneIds({ activeWorktreeId: 'a', workspaceSplitLayout: tree })
    ).toEqual(['a', 'b', 'c'])
  })
})
