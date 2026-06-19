import { describe, expect, it, vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../shared/types'
import { layoutCoversLeaves, resolveTerminalLayoutRoot } from './remote-terminal-layout-resolution'

const verticalSplit: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'a' },
  second: { type: 'leaf', leafId: 'b' }
}

describe('layoutCoversLeaves', () => {
  it('is true when the tree has exactly the leaves', () => {
    expect(layoutCoversLeaves(verticalSplit, ['a', 'b'])).toBe(true)
  })
  it('is false when a leaf is missing from the tree', () => {
    expect(layoutCoversLeaves({ type: 'leaf', leafId: 'a' }, ['a', 'b'])).toBe(false)
  })
  it('is false when the tree has an extra leaf', () => {
    expect(layoutCoversLeaves(verticalSplit, ['a'])).toBe(false)
  })
  it('is false for a null tree', () => {
    expect(layoutCoversLeaves(null, ['a'])).toBe(false)
  })
})

describe('resolveTerminalLayoutRoot', () => {
  it('uses the authoritative tree verbatim — direction is preserved', () => {
    // Why: the "Split Right renders as down" bug was re-deriving direction
    // instead of trusting the host tree. The authoritative tree must win.
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: verticalSplit,
      leafIds: ['a', 'b']
    })
    expect(root).toBe(verticalSplit)
    expect(root?.type === 'split' && root.direction).toBe('vertical')
  })

  it('falls back to the prior client tree (keeping direction) when authoritative does not cover the leaves', () => {
    // A transitional snapshot where the host tree is momentarily stale/partial
    // must NOT collapse to a guessed direction — keep the known-good tree.
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: { type: 'leaf', leafId: 'a' }, // stale single-leaf
      existingRoot: verticalSplit,
      leafIds: ['a', 'b']
    })
    expect(root).toBe(verticalSplit)
  })

  it('never invents a split direction: synthesis only fires (and is reported) when no tree covers the leaves', () => {
    const onSynthesize = vi.fn()
    resolveTerminalLayoutRoot({
      authoritativeRoot: undefined,
      existingRoot: undefined,
      leafIds: ['a', 'b'],
      onSynthesize
    })
    expect(onSynthesize).toHaveBeenCalledWith(2)
  })

  it('does not report synthesis for a single leaf (direction is irrelevant)', () => {
    const onSynthesize = vi.fn()
    const root = resolveTerminalLayoutRoot({ leafIds: ['a'], onSynthesize })
    expect(root).toEqual({ type: 'leaf', leafId: 'a' })
    expect(onSynthesize).not.toHaveBeenCalled()
  })

  it('returns null for no leaves', () => {
    expect(resolveTerminalLayoutRoot({ leafIds: [] })).toBeNull()
  })

  it('prefers authoritative over an also-covering existing tree', () => {
    const horizontalSplit: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'a' },
      second: { type: 'leaf', leafId: 'b' }
    }
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: verticalSplit,
      existingRoot: horizontalSplit,
      leafIds: ['a', 'b']
    })
    expect(root).toBe(verticalSplit)
  })
})
