import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { createTerminalLayoutTopologySignature } from './terminal-layout-leaf-topology'

describe('createTerminalLayoutTopologySignature', () => {
  const TAB_ID = 'tab-1'
  const LEAF_A = '11111111-1111-4111-8111-111111111111'
  const LEAF_B = '22222222-2222-4222-8222-222222222222'

  function layoutsWithLeaf(leafId: string, ptyId?: string): Record<string, TerminalLayoutSnapshot> {
    return {
      [TAB_ID]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {})
      }
    }
  }

  it('does not change when a new layout object has the same leaf topology', () => {
    const signature = createTerminalLayoutTopologySignature()
    const first = signature.project(layoutsWithLeaf(LEAF_A, 'pty-1'))
    // Why: a different object reference (e.g. a ptyId-only rewrite from
    // replaceTerminalLayoutPanePtyId) must not bump the signature — that is
    // the whole point, since this is what keeps the sync effect from
    // re-running on every unrelated terminal byte.
    const second = signature.project(layoutsWithLeaf(LEAF_A, 'pty-2'))
    expect(second).toBe(first)
  })

  it('changes when a tab leaf is replaced', () => {
    const signature = createTerminalLayoutTopologySignature()
    const first = signature.project(layoutsWithLeaf(LEAF_A))
    const second = signature.project(layoutsWithLeaf(LEAF_B))
    expect(second).not.toBe(first)
  })

  it('returns the cached value for the exact same object reference', () => {
    const signature = createTerminalLayoutTopologySignature()
    const layouts = layoutsWithLeaf(LEAF_A)
    const first = signature.project(layouts)
    const second = signature.project(layouts)
    expect(second).toBe(first)
  })

  function splitLayout(ratio: number): Record<string, TerminalLayoutSnapshot> {
    return {
      [TAB_ID]: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_B },
          ratio
        },
        activeLeafId: LEAF_A,
        expandedLeafId: null
      }
    }
  }

  it('does not change when only the split ratio changes (e.g. dragging the divider)', () => {
    const signature = createTerminalLayoutTopologySignature()
    const first = signature.project(splitLayout(0.5))
    // Why: dragging a split divider calls setTabLayout every frame with a
    // changed ratio — the leaf id set (what pruning cares about) is
    // untouched, so this must not re-trigger the retention sync per frame.
    const second = signature.project(splitLayout(0.73))
    expect(second).toBe(first)
  })
})
