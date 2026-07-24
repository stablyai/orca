import { describe, expect, it } from 'vitest'
import {
  hasSleepableWorkspaceActivity,
  isContextWorktreeDeletable,
  shouldUseNativeContextMenu,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldRemoveProjectFromContextMenu,
  shouldSuppressContextMenuFollowUpClick,
  shouldContinueDeleteSiblingPositionRestore,
  getWorktreeParentPickerAnchor,
  getWorktreeParentPickerLabel,
  hasWorktreeParentLink,
  isWorktreeParentPickerDisabled,
  planWorkspaceStatusAssignment,
  selectMenuScopedMap
} from './WorktreeContextMenu'
import type { Worktree, WorktreeLineage, WorkspaceStatusDefinition } from '../../../../shared/types'

describe('selectMenuScopedMap (delete-teardown re-render guard)', () => {
  // Why: the closed menu wrapper must stay inert to delete teardown's high-churn
  // set()s. The guard is referential stability — when closed, the selector must
  // return the SAME `empty` reference even as the live map identity changes each
  // teardown set(), so Zustand's Object.is equality short-circuits the subscription
  // and the (common) closed wrapper does not re-render. These assertions pin that
  // contract; if they regress, every visible card re-renders on every teardown set()
  // and worktree-card hover popovers stall during a delete.
  it('returns the stable empty sentinel when the menu is closed', () => {
    const empty = Object.freeze({})
    const liveA = { 'wt-1': ['pty-1'] }
    const liveB = { 'wt-2': ['pty-2'] }
    // Live map identity churns across teardown set()s, yet a closed wrapper keeps
    // the same reference — no subscription wakeup.
    expect(selectMenuScopedMap(false, liveA, empty)).toBe(empty)
    expect(selectMenuScopedMap(false, liveB, empty)).toBe(empty)
    expect(selectMenuScopedMap(false, liveA, empty)).toBe(selectMenuScopedMap(false, liveB, empty))
  })

  it('returns the live map synchronously once the menu is open', () => {
    const empty = Object.freeze({})
    const live = { 'wt-1': ['pty-1'] }
    // The render where menuOpen flips true must read real data so menu items
    // (sleep/delete/lineage) reflect live tabs/ptys/delete state.
    expect(selectMenuScopedMap(true, live, empty)).toBe(live)
  })
})

describe('shouldUseNativeContextMenu', () => {
  it('uses the browser context menu for marked hovercard content', () => {
    const target = {
      closest: (selector: string) =>
        selector === '[data-worktree-native-context-menu]' ? ({} as Element) : null
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(true)
  })

  it('uses the browser context menu for text nodes inside marked content', () => {
    const target = {
      parentElement: {
        closest: (selector: string) =>
          selector === '[data-worktree-native-context-menu]' ? ({} as Element) : null
      }
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(true)
  })

  it('keeps the worktree context menu for unmarked targets', () => {
    const target = {
      closest: () => null
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(false)
  })
})

describe('shouldIgnoreNestedWorktreeContextMenuScope', () => {
  it('allows the context menu scope that owns the event target', () => {
    const currentScope = {} as EventTarget
    const target = {
      closest: () => currentScope
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(false)
  })

  it('ignores context menu events owned by a nested scope', () => {
    const currentScope = {} as EventTarget
    const nestedScope = {} as Element
    const target = {
      closest: () => nestedScope
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(true)
  })

  it('ignores context menu events from text nodes inside a nested scope', () => {
    const currentScope = {} as EventTarget
    const nestedScope = {} as Element
    const target = {
      parentElement: {
        closest: () => nestedScope
      }
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(true)
  })

  it('allows events from unscoped targets', () => {
    const currentScope = {} as EventTarget
    const target = {
      closest: () => null
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(false)
  })
})

describe('shouldSuppressContextMenuFollowUpClick', () => {
  it('suppresses the click emitted immediately after opening a context menu', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 1_050)).toBe(true)
  })

  it('does not suppress later unrelated clicks', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 1_700)).toBe(false)
  })

  it('does not suppress clicks that predate the context menu timestamp', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 999)).toBe(false)
  })
})

describe('shouldContinueDeleteSiblingPositionRestore', () => {
  it('stops once the delete row position has settled even when the row remains mounted', () => {
    expect(
      shouldContinueDeleteSiblingPositionRestore({
        attempts: 6,
        stableFrames: 6
      })
    ).toBe(false)
  })
})

describe('parent picker context menu affordance', () => {
  it('offers unlink for valid inline-only legacy lineage after stable-update hydration', () => {
    const parent = { id: 'repo::parent', instanceId: 'parent-instance' }
    const lineage: WorktreeLineage = {
      worktreeId: 'repo::child',
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId,
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
      createdAt: 1
    }
    const child = {
      id: lineage.worktreeId,
      instanceId: lineage.worktreeInstanceId,
      lineage
    } as Worktree & { lineage: WorktreeLineage }

    expect(hasWorktreeParentLink(child, {}, {})).toBe(true)
  })

  it('uses set/change labels based on valid parent presence', () => {
    expect(getWorktreeParentPickerLabel(null)).toBe('Set Parent Worktree...')
    expect(getWorktreeParentPickerLabel('parent-1')).toBe('Change Parent Worktree...')
  })

  it('disables the parent picker while deleting or without candidates', () => {
    expect(isWorktreeParentPickerDisabled({ isDeleting: true, eligibleParentCount: 1 })).toBe(true)
    expect(isWorktreeParentPickerDisabled({ isDeleting: false, eligibleParentCount: 0 })).toBe(true)
    expect(isWorktreeParentPickerDisabled({ isDeleting: false, eligibleParentCount: 1 })).toBe(
      false
    )
  })

  it('snapshots the stable row anchor before the context menu closes', () => {
    const card = { dataset: { worktreeDragId: 'child' } } as unknown as HTMLElement
    const scope = {
      closest: (selector: string) => (selector === '[data-worktree-drag-id]' ? card : null)
    } as HTMLElement

    expect(getWorktreeParentPickerAnchor(scope, 'child')).toBe(card)
  })

  it('uses the child scope instead of climbing to a different workspace drag row', () => {
    const parentCard = { dataset: { worktreeDragId: 'parent' } } as unknown as HTMLElement
    const scope = {
      closest: (selector: string) => (selector === '[data-worktree-drag-id]' ? parentCard : null)
    } as HTMLElement

    expect(getWorktreeParentPickerAnchor(scope, 'child')).toBe(scope)
  })
})

describe('hasSleepableWorkspaceActivity', () => {
  it('treats preserved empty PTY arrays as slept, not live', () => {
    expect(
      hasSleepableWorkspaceActivity('wt-1', { 'wt-1': [{ id: 'tab-1' }] }, { 'tab-1': [] }, {})
    ).toBe(false)
  })

  it('detects live terminal and browser activity', () => {
    expect(
      hasSleepableWorkspaceActivity(
        'wt-1',
        { 'wt-1': [{ id: 'tab-1' }] },
        { 'tab-1': ['pty-1'] },
        {}
      )
    ).toBe(true)
    expect(hasSleepableWorkspaceActivity('wt-1', {}, {}, { 'wt-1': [{ id: 'browser-1' }] })).toBe(
      true
    )
  })
})

describe('project removal from workspace context menus', () => {
  it('routes primary workspace rows to project removal in non-repo grouped views', () => {
    const gitRepo = { id: 'repo-1' }
    const folderRepo = { id: 'folder-1' }

    expect(shouldRemoveProjectFromContextMenu(gitRepo, { isMainWorktree: true })).toBe(true)
    expect(shouldRemoveProjectFromContextMenu(folderRepo, { isMainWorktree: true })).toBe(true)
    expect(shouldRemoveProjectFromContextMenu(gitRepo, { isMainWorktree: false })).toBe(false)
    expect(shouldRemoveProjectFromContextMenu(null, { isMainWorktree: true })).toBe(false)
  })

  it('treats additional folder workspace rows as deletable workspace rows', () => {
    const folderRepo = { kind: 'folder' as const }

    expect(isContextWorktreeDeletable({ isMainWorktree: false }, folderRepo)).toBe(true)
    expect(isContextWorktreeDeletable({ isMainWorktree: true }, folderRepo)).toBe(false)
    expect(isContextWorktreeDeletable({ isMainWorktree: false }, null)).toBe(false)
  })
})

describe('planWorkspaceStatusAssignment (context-menu "Move to Status" routing)', () => {
  // Why: this is the exact branch #10175 regressed on — the board must funnel
  // through the Linear-sync callback, the sidebar list must stay local-only. A
  // silent flip of either branch re-introduces the bug, so pin both here.
  const statuses: WorkspaceStatusDefinition[] = [
    { id: 'todo', label: 'Todo' },
    { id: 'in-review', label: 'In review' }
  ]
  const wt = (id: string, workspaceStatus: string): Worktree =>
    ({ id, workspaceStatus }) as Worktree

  it('routes to board Linear-sync with ALL selected ids when the board wired a callback', () => {
    // The board path forwards every id; moveWorktreesToStatus filters no-ops downstream.
    expect(
      planWorkspaceStatusAssignment(
        [wt('a', 'todo'), wt('b', 'in-review')],
        'in-review',
        statuses,
        true
      )
    ).toEqual({ kind: 'board-sync', worktreeIds: ['a', 'b'] })
  })

  it('falls back to local-only writes of only status-changed worktrees off the board', () => {
    expect(
      planWorkspaceStatusAssignment(
        [wt('a', 'todo'), wt('b', 'in-review')],
        'in-review',
        statuses,
        false
      )
    ).toEqual({ kind: 'local-only', localWriteIds: ['a'] })
  })

  it('writes nothing on the local-only path when every worktree already has the target status', () => {
    expect(
      planWorkspaceStatusAssignment(
        [wt('a', 'in-review'), wt('b', 'in-review')],
        'in-review',
        statuses,
        false
      )
    ).toEqual({ kind: 'local-only', localWriteIds: [] })
  })
})
