import { describe, expect, it } from 'vitest'
import {
  hasSleepableWorkspaceActivity,
  isContextWorktreeDeletable,
  shouldUseNativeContextMenu,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldRemoveFolderProjectFromContextMenu,
  shouldSuppressContextMenuFollowUpClick,
  shouldContinueDeleteSiblingPositionRestore
} from './WorktreeContextMenu'

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

describe('folder workspace context deletes', () => {
  it('routes only the folder root row to project removal', () => {
    expect(shouldRemoveFolderProjectFromContextMenu(true, { isMainWorktree: true })).toBe(true)
    expect(shouldRemoveFolderProjectFromContextMenu(true, { isMainWorktree: false })).toBe(false)
    expect(shouldRemoveFolderProjectFromContextMenu(false, { isMainWorktree: true })).toBe(false)
  })

  it('treats additional folder workspace rows as deletable workspace rows', () => {
    const folderRepo = { kind: 'folder' as const }

    expect(isContextWorktreeDeletable({ isMainWorktree: false }, folderRepo)).toBe(true)
    expect(isContextWorktreeDeletable({ isMainWorktree: true }, folderRepo)).toBe(false)
    expect(isContextWorktreeDeletable({ isMainWorktree: false }, null)).toBe(false)
  })
})
