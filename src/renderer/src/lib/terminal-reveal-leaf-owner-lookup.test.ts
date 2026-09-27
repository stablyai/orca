// Which tab owns a leaf id decides whether a reveal adopts a pane or mints a second one
// (STA-7961). Two layouts can name the same leaf: one that still mounts it, and one left
// holding the id by a detach.
import { describe, expect, it } from 'vitest'
import { findTerminalTabIdBindingLeafId } from './terminal-reveal-tab-adoption'
import type { AppState } from '@/store/types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'

const SHARED_LEAF_ID = 'leaf-shared'

function layout(
  root: TerminalPaneLayoutNode | null,
  ptyIdsByLeafId?: Record<string, string>
): TerminalLayoutSnapshot {
  return {
    root,
    activeLeafId: null,
    expandedLeafId: null,
    ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {})
  }
}

function leaf(leafId: string): TerminalPaneLayoutNode {
  return { type: 'leaf', leafId }
}

function lookup(layoutsByTabId: AppState['terminalLayoutsByTabId']): string | null {
  return findTerminalTabIdBindingLeafId({ terminalLayoutsByTabId: layoutsByTabId }, SHARED_LEAF_ID)
}

describe('findTerminalTabIdBindingLeafId', () => {
  it('skips a stranded binding whose own tree no longer holds the leaf', () => {
    // The detached pane left tab-ghost's map entry behind; only tab-live can mount the leaf.
    expect(
      lookup({
        'tab-ghost': layout(leaf('leaf-other'), { [SHARED_LEAF_ID]: 'pty-stale' }),
        'tab-live': layout(leaf(SHARED_LEAF_ID), { [SHARED_LEAF_ID]: 'pty-live' })
      })
    ).toBe('tab-live')
  })

  it('keeps answering a layout that records no tree at all', () => {
    expect(lookup({ 'tab-a': layout(null, { [SHARED_LEAF_ID]: 'pty-a' }) })).toBe('tab-a')
  })

  it('prefers the tab that binds the leaf over one that only carries it unbound', () => {
    // A pane keeps its leaf in the tree after its PTY exits, so the id outlives the binding.
    const bound = layout(leaf(SHARED_LEAF_ID), { [SHARED_LEAF_ID]: 'pty-a' })
    const unbound = layout(leaf(SHARED_LEAF_ID))

    expect(lookup({ 'tab-bound': bound, 'tab-unbound': unbound })).toBe('tab-bound')
    expect(lookup({ 'tab-unbound': unbound, 'tab-bound': bound })).toBe('tab-bound')
  })

  it('falls back to an unbound carrier when no tab binds the leaf', () => {
    expect(lookup({ 'tab-unbound': layout(leaf(SHARED_LEAF_ID)) })).toBe('tab-unbound')
  })

  it('returns null when no layout names the leaf', () => {
    expect(lookup({ 'tab-a': layout(leaf('leaf-other'), { 'leaf-other': 'pty-a' }) })).toBeNull()
  })
})
