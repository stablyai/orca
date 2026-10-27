import { describe, expect, it } from 'vitest'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'
import { normalizeTerminalLayoutSnapshot } from './terminal-layout-leaf-ids'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'
const MISSING_LEAF = '99999999-9999-4999-8999-999999999999'

function split(firstLeafId: string, secondLeafId: string): TerminalPaneLayoutNode {
  return {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: firstLeafId },
    second: { type: 'leaf', leafId: secondLeafId }
  }
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_2 },
        second: { type: 'leaf', leafId: LEAF_3 }
      }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: LEAF_3,
    ptyIdsByLeafId: {
      [LEAF_1]: 'pty-1',
      [LEAF_2]: 'pty-2',
      [LEAF_3]: 'pty-3'
    }
  }
}

describe('normalizeTerminalLayoutSnapshot active leaf repair', () => {
  it('prefers a rootless active leaf over multiple retained PTY bindings', () => {
    const result = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: LEAF_3,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-1',
        [LEAF_2]: 'pty-2'
      }
    })

    expect(result.changed).toBe(false)
    expect(result.snapshot.activeLeafId).toBe(LEAF_3)
  })

  it('does not pick an arbitrary rootless PTY binding when multiple remain', () => {
    const result = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-1',
        [LEAF_2]: 'pty-2'
      }
    })

    expect(result.changed).toBe(false)
    expect(result.snapshot.activeLeafId).toBeNull()
  })

  it('repairs a hydrated active leaf that has lost its PTY while a sibling is bound', () => {
    const result = normalizeTerminalLayoutSnapshot({
      root: split(LEAF_1, LEAF_2),
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-2' }
    })

    expect(result.changed).toBe(true)
    expect(result.snapshot.activeLeafId).toBe(LEAF_2)
    expect(result.snapshot.ptyIdsByLeafId).toEqual({ [LEAF_2]: 'pty-2' })
  })

  it('repairs stale active leaf ids to the first bound leaf in the root layout', () => {
    const layout = splitLayout()
    layout.activeLeafId = MISSING_LEAF

    const normalized = normalizeTerminalLayoutSnapshot(layout)

    expect(normalized.changed).toBe(true)
    expect(normalized.snapshot.activeLeafId).toBe(LEAF_1)
    expect(normalized.snapshot.expandedLeafId).toBe(LEAF_3)
    expect(normalized.snapshot.ptyIdsByLeafId).toEqual(layout.ptyIdsByLeafId)
  })

  it('clears stale expanded leaf ids without changing a valid active leaf', () => {
    const layout = splitLayout()
    layout.expandedLeafId = MISSING_LEAF

    const normalized = normalizeTerminalLayoutSnapshot(layout)

    expect(normalized.changed).toBe(true)
    expect(normalized.snapshot.activeLeafId).toBe(LEAF_2)
    expect(normalized.snapshot.expandedLeafId).toBeNull()
  })
})
