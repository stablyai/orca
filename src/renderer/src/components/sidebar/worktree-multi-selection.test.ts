import { describe, expect, it } from 'vitest'
import {
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeSelection
} from './worktree-multi-selection'

const visibleIds = ['wt-1', 'wt-2', 'wt-3', 'wt-4']

describe('worktree multi selection', () => {
  it('uses Cmd on Mac and Ctrl elsewhere for toggle selection', () => {
    expect(
      getWorktreeSelectionIntent({ metaKey: true, ctrlKey: false, shiftKey: false }, true)
    ).toBe('toggle')
    expect(
      getWorktreeSelectionIntent({ metaKey: false, ctrlKey: true, shiftKey: false }, false)
    ).toBe('toggle')
    expect(
      getWorktreeSelectionIntent({ metaKey: false, ctrlKey: false, shiftKey: true }, false)
    ).toBe('range')
  })

  it('replaces selection on plain click', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1', 'wt-2']),
      previousAnchorId: 'wt-1',
      targetId: 'wt-3',
      intent: 'replace'
    })

    expect([...result.selectedIds]).toEqual(['wt-3'])
    expect(result.anchorId).toBe('wt-3')
  })

  it('toggles one worktree without dropping the rest', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1', 'wt-2']),
      previousAnchorId: 'wt-2',
      targetId: 'wt-3',
      intent: 'toggle'
    })

    expect([...result.selectedIds]).toEqual(['wt-1', 'wt-2', 'wt-3'])
    expect(result.anchorId).toBe('wt-3')
  })

  it('allows toggling the last selected worktree off', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-2']),
      previousAnchorId: 'wt-2',
      targetId: 'wt-2',
      intent: 'toggle'
    })

    expect([...result.selectedIds]).toEqual([])
    expect(result.anchorId).toBe('wt-2')
  })

  it('selects the visible range from the anchor to the target', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1']),
      previousAnchorId: 'wt-1',
      targetId: 'wt-3',
      intent: 'range'
    })

    expect([...result.selectedIds]).toEqual(['wt-1', 'wt-2', 'wt-3'])
    expect(result.anchorId).toBe('wt-1')
  })

  it('prunes selection when filtering hides selected worktrees', () => {
    const result = pruneWorktreeSelection(new Set(['wt-1', 'wt-3']), 'wt-1', ['wt-2', 'wt-3'])

    expect([...result.selectedIds]).toEqual(['wt-3'])
    expect(result.anchorId).toBe('wt-3')
  })
})
