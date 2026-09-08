import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { resolveAgentRowPaneLiveTitle } from './agent-row-pane-live-title'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

const SPLIT: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: LEAF_A },
    second: { type: 'leaf', leafId: LEAF_B }
  },
  activeLeafId: LEAF_A,
  expandedLeafId: null
}

describe('resolveAgentRowPaneLiveTitle', () => {
  it('returns undefined for a single-pane tab, where the tab title is the pane title', () => {
    const single: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: LEAF_A },
      activeLeafId: LEAF_A,
      expandedLeafId: null
    }
    expect(resolveAgentRowPaneLiveTitle(single, { 1: '✳ Redis cache' }, LEAF_A)).toBeUndefined()
    expect(resolveAgentRowPaneLiveTitle(undefined, { 1: '✳ Redis cache' }, LEAF_A)).toBeUndefined()
  })

  it('gives each leaf of a split its own runtime pane title', () => {
    const titles = { 1: '✳ Linear work log', 2: '✳ Redis cache strategy' }
    expect(resolveAgentRowPaneLiveTitle(SPLIT, titles, LEAF_A)).toBe('✳ Linear work log')
    expect(resolveAgentRowPaneLiveTitle(SPLIT, titles, LEAF_B)).toBe('✳ Redis cache strategy')
  })

  it('returns null rather than a sibling title when the pane has no slot', () => {
    expect(resolveAgentRowPaneLiveTitle(SPLIT, { 1: '✳ Linear work log' }, LEAF_B)).toBeNull()
    expect(resolveAgentRowPaneLiveTitle(SPLIT, undefined, LEAF_A)).toBeNull()
    // A leaf that is not in this layout must never inherit a pane title.
    expect(resolveAgentRowPaneLiveTitle(SPLIT, { 1: 'a', 2: 'b' }, LEAF_C)).toBeNull()
    // An unparseable paneKey yields no leaf id, which must suppress, not guess.
    expect(resolveAgentRowPaneLiveTitle(SPLIT, { 1: 'a', 2: 'b' }, undefined)).toBeNull()
  })

  it('walks replay creation order, not tree order, for a nested split', () => {
    // Left pane split again: tree order is [A, C, B], creation order is [A, B, C].
    const nested: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_C }
        },
        second: { type: 'leaf', leafId: LEAF_B }
      },
      activeLeafId: LEAF_A,
      expandedLeafId: null
    }
    const titles = { 1: 'first', 2: 'second', 3: 'third' }
    expect(resolveAgentRowPaneLiveTitle(nested, titles, LEAF_A)).toBe('first')
    expect(resolveAgentRowPaneLiveTitle(nested, titles, LEAF_B)).toBe('second')
    expect(resolveAgentRowPaneLiveTitle(nested, titles, LEAF_C)).toBe('third')
  })
})
