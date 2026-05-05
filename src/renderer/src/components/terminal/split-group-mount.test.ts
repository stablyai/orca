import { describe, expect, it } from 'vitest'
import { getEffectiveLayoutForWorktree, anyMountedWorktreeHasLayout } from './split-group-mount'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/types'

function makeGroup(id: string, worktreeId: string): TabGroup {
  return { id, worktreeId, activeTabId: null, tabOrder: [] }
}

describe('getEffectiveLayoutForWorktree', () => {
  it('returns the explicit layout when one exists', () => {
    const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'g1' }
    const result = getEffectiveLayoutForWorktree('wt-1', { 'wt-1': layout }, {}, {})
    expect(result).toBe(layout)
  })

  it('falls back to a synthetic leaf from the active group', () => {
    const result = getEffectiveLayoutForWorktree(
      'wt-1',
      {},
      { 'wt-1': [makeGroup('g1', 'wt-1'), makeGroup('g2', 'wt-1')] },
      { 'wt-1': 'g2' }
    )
    expect(result).toEqual({ type: 'leaf', groupId: 'g2' })
  })

  it('falls back to the first group when no active group is set', () => {
    const result = getEffectiveLayoutForWorktree(
      'wt-1',
      {},
      { 'wt-1': [makeGroup('g1', 'wt-1')] },
      {}
    )
    expect(result).toEqual({ type: 'leaf', groupId: 'g1' })
  })

  it('returns undefined when the worktree has no layout and no groups', () => {
    const result = getEffectiveLayoutForWorktree('wt-1', {}, {}, {})
    expect(result).toBeUndefined()
  })
})

describe('anyMountedWorktreeHasLayout', () => {
  const layout: TabGroupLayoutNode = { type: 'leaf', groupId: 'g1' }

  it('returns true when the active worktree has a layout', () => {
    const result = anyMountedWorktreeHasLayout(
      ['wt-1'],
      new Set(['wt-1']),
      { 'wt-1': layout },
      {},
      {}
    )
    expect(result).toBe(true)
  })

  it('returns true when only a non-active mounted worktree has a layout (the bug fix)', () => {
    // wt-1 has a layout, wt-2 (the newly active one) does not
    const result = anyMountedWorktreeHasLayout(
      ['wt-1', 'wt-2'],
      new Set(['wt-1', 'wt-2']),
      { 'wt-1': layout },
      {},
      {}
    )
    expect(result).toBe(true)
  })

  it('returns false when no mounted worktree has a layout', () => {
    const result = anyMountedWorktreeHasLayout(
      ['wt-1', 'wt-2'],
      new Set(['wt-1', 'wt-2']),
      {},
      {},
      {}
    )
    expect(result).toBe(false)
  })

  it('ignores worktrees that exist but are not mounted', () => {
    const result = anyMountedWorktreeHasLayout(
      ['wt-1', 'wt-2'],
      new Set(['wt-2']), // only wt-2 is mounted
      { 'wt-1': layout }, // only wt-1 has a layout
      {},
      {}
    )
    expect(result).toBe(false)
  })

  it('considers fallback groups when no explicit layout exists', () => {
    const result = anyMountedWorktreeHasLayout(
      ['wt-1'],
      new Set(['wt-1']),
      {},
      { 'wt-1': [makeGroup('g1', 'wt-1')] },
      {}
    )
    expect(result).toBe(true)
  })
})
