import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'
import { pruneUnboundTerminalLayoutLeaves } from './terminal-layout-unbound-leaf-prune'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'
const LEAF_4 = '44444444-4444-4444-8444-444444444444'

function leaf(leafId: string): TerminalPaneLayoutNode {
  return { type: 'leaf', leafId }
}

function split(
  first: TerminalPaneLayoutNode,
  second: TerminalPaneLayoutNode,
  ratio?: number
): TerminalPaneLayoutNode {
  return { type: 'split', direction: 'vertical', first, second, ...(ratio ? { ratio } : {}) }
}

// The field incident shape: split(split(agent, teammate), setup) where the
// setup pane's PTY and binding were torn down but the persisted root kept the
// leaf, so a remount materialized a permanently blank pane.
function ghostIncidentLayout(): TerminalLayoutSnapshot {
  return {
    root: split(split(leaf(LEAF_1), leaf(LEAF_2)), leaf(LEAF_3), 0.548),
    activeLeafId: LEAF_1,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [LEAF_1]: 'pty-agent',
      [LEAF_2]: 'pty-teammate'
    },
    titlesByLeafId: {
      [LEAF_1]: 'agent',
      [LEAF_3]: 'Setup'
    }
  }
}

describe('pruneUnboundTerminalLayoutLeaves', () => {
  it('collapses an unbound leaf beside bound siblings (field incident shape)', () => {
    const { snapshot, changed } = pruneUnboundTerminalLayoutLeaves(ghostIncidentLayout())
    expect(changed).toBe(true)
    expect(snapshot.root).toEqual(split(leaf(LEAF_1), leaf(LEAF_2)))
    expect(snapshot.activeLeafId).toBe(LEAF_1)
    expect(snapshot.ptyIdsByLeafId).toEqual({
      [LEAF_1]: 'pty-agent',
      [LEAF_2]: 'pty-teammate'
    })
    expect(snapshot.titlesByLeafId).toEqual({ [LEAF_1]: 'agent' })
  })

  it('promotes the surviving sibling of a pruned nested split', () => {
    const { snapshot, changed } = pruneUnboundTerminalLayoutLeaves({
      root: split(leaf(LEAF_1), split(leaf(LEAF_2), leaf(LEAF_3)), 0.7),
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_3]: 'pty-3' }
    })
    expect(changed).toBe(true)
    expect(snapshot.root).toEqual(split(leaf(LEAF_1), leaf(LEAF_3), 0.7))
  })

  it('prunes multiple unbound leaves in one pass', () => {
    const { snapshot, changed } = pruneUnboundTerminalLayoutLeaves({
      root: split(split(leaf(LEAF_1), leaf(LEAF_2)), split(leaf(LEAF_3), leaf(LEAF_4))),
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-2' }
    })
    expect(changed).toBe(true)
    expect(snapshot.root).toEqual(leaf(LEAF_2))
    expect(snapshot.activeLeafId).toBe(LEAF_2)
  })

  it('repairs activeLeafId and expandedLeafId when they pointed at a pruned leaf', () => {
    const { snapshot } = pruneUnboundTerminalLayoutLeaves({
      root: split(leaf(LEAF_1), leaf(LEAF_2)),
      activeLeafId: LEAF_2,
      expandedLeafId: LEAF_2,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-1' }
    })
    expect(snapshot.root).toEqual(leaf(LEAF_1))
    expect(snapshot.activeLeafId).toBe(LEAF_1)
    expect(snapshot.expandedLeafId).toBeNull()
  })

  it('keeps an unbound leaf that has captured scrollback buffers', () => {
    const layout: TerminalLayoutSnapshot = {
      root: split(leaf(LEAF_1), leaf(LEAF_2)),
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-1' },
      buffersByLeafId: { [LEAF_2]: 'saved output' }
    }
    const { snapshot, changed } = pruneUnboundTerminalLayoutLeaves(layout)
    expect(changed).toBe(false)
    expect(snapshot).toBe(layout)
  })

  it('keeps an unbound leaf that has a durable scrollback ref', () => {
    const { changed } = pruneUnboundTerminalLayoutLeaves({
      root: split(leaf(LEAF_1), leaf(LEAF_2)),
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-1' },
      scrollbackRefsByLeafId: { [LEAF_2]: 'ref-2' }
    })
    expect(changed).toBe(false)
  })

  it('never prunes when no leaf is bound (app-restart restore drops the pty map)', () => {
    const layout: TerminalLayoutSnapshot = {
      root: split(leaf(LEAF_1), leaf(LEAF_2)),
      activeLeafId: LEAF_1,
      expandedLeafId: null
    }
    const { snapshot, changed } = pruneUnboundTerminalLayoutLeaves(layout)
    expect(changed).toBe(false)
    expect(snapshot).toBe(layout)
  })

  it('ignores pty map entries for leaves that are not in the tree', () => {
    // A binding for a leaf outside root must not count as "bound tree".
    const { changed } = pruneUnboundTerminalLayoutLeaves({
      root: split(leaf(LEAF_1), leaf(LEAF_2)),
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_3]: 'pty-elsewhere' }
    })
    expect(changed).toBe(false)
  })

  it('leaves single-leaf and rootless snapshots untouched', () => {
    const singleLeaf: TerminalLayoutSnapshot = {
      root: leaf(LEAF_1),
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }
    expect(pruneUnboundTerminalLayoutLeaves(singleLeaf).changed).toBe(false)
    const rootless: TerminalLayoutSnapshot = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }
    expect(pruneUnboundTerminalLayoutLeaves(rootless).changed).toBe(false)
  })

  it('returns the input snapshot unchanged when every leaf is bound', () => {
    const layout: TerminalLayoutSnapshot = {
      root: split(leaf(LEAF_1), leaf(LEAF_2)),
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2' }
    }
    const { snapshot, changed } = pruneUnboundTerminalLayoutLeaves(layout)
    expect(changed).toBe(false)
    expect(snapshot).toBe(layout)
  })
})
