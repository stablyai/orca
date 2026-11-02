import { describe, expect, it, vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import { resolveTerminalLayoutRoot } from './remote-terminal-layout-resolution'

const verticalSplit: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'a' },
  second: { type: 'leaf', leafId: 'b' }
}

describe('resolveTerminalLayoutRoot', () => {
  it('uses the authoritative tree verbatim — direction is preserved', () => {
    // Host split direction must win; re-derivation once turned Split Right into down.
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: verticalSplit,
      leafIds: ['a', 'b']
    })
    expect(root).toBe(verticalSplit)
    expect(root?.type === 'split' && root.direction).toBe('vertical')
  })

  it('falls back to the prior client tree (keeping direction) when authoritative does not cover the leaves', () => {
    // Stale/partial host trees must retain known directions rather than guess.
    const root = resolveTerminalLayoutRoot({
      authoritativeRoot: { type: 'leaf', leafId: 'a' }, // stale single-leaf
      existingRoot: verticalSplit,
      leafIds: ['a', 'b']
    })
    expect(root).toBe(verticalSplit)
  })

  it('prunes a superset tree to the live leaves instead of re-guessing its directions', () => {
    // Extra stale leaves must not make exact-cover failure replace the whole known tree with guessed directions.
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
