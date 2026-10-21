import { describe, expect, it, vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
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

  it('prunes a superset tree to the live leaves instead of re-guessing its directions', () => {
    // A stale/extra leaf in the known tree used to fail the exact-cover check and
    // collapse the whole tab to a guessed chain.
    const onSynthesize = vi.fn()
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: {
        type: 'split',
        direction: 'horizontal',
        first: verticalSplit,
        second: { type: 'leaf', leafId: 'stale' }
      },
      leafIds: ['a', 'b'],
      onSynthesize
    })
    expect(root).toEqual(verticalSplit)
    expect(onSynthesize).not.toHaveBeenCalled()
  })

  it('collapses a split that loses one child and keeps the outer direction', () => {
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'a' },
          second: { type: 'leaf', leafId: 'b' }
        },
        second: { type: 'leaf', leafId: 'c' }
      },
      leafIds: ['a', 'c']
    })
    expect(root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'a' },
      second: { type: 'leaf', leafId: 'c' }
    })
  })

  it('grafts a genuinely new leaf without disturbing the directions already known', () => {
    // Only the new leaf's placement is a guess; the vertical split must survive it.
    const onSynthesize = vi.fn()
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: verticalSplit,
      leafIds: ['a', 'b', 'c'],
      onSynthesize
    })
    expect(root).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: verticalSplit,
      second: { type: 'leaf', leafId: 'c' }
    })
    expect(onSynthesize).toHaveBeenCalledWith(1)
  })

  it('keeps the prior client tree when the host tree places fewer of the leaves', () => {
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: { type: 'leaf', leafId: 'a' },
      existingRoot: verticalSplit,
      leafIds: ['a', 'b', 'c']
    })
    expect(root).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: verticalSplit,
      second: { type: 'leaf', leafId: 'c' }
    })
  })

  it('still degenerates when no known tree places any of the leaves', () => {
    const onSynthesize = vi.fn()
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: verticalSplit,
      leafIds: ['x', 'y'],
      onSynthesize
    })
    expect(root).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'x' },
      second: { type: 'leaf', leafId: 'y' }
    })
    expect(onSynthesize).toHaveBeenCalledWith(2)
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
