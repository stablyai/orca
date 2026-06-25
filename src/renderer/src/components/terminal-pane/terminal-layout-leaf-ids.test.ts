import { describe, expect, it } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'
import {
  normalizeTerminalLayoutSnapshot,
  resolveTerminalLayoutActiveLeafId
} from './terminal-layout-leaf-ids'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

function split(firstLeafId: string, secondLeafId: string): TerminalPaneLayoutNode {
  return {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: firstLeafId },
    second: { type: 'leaf', leafId: secondLeafId }
  }
}

describe('resolveTerminalLayoutActiveLeafId', () => {
  it('keeps the active leaf when it is still PTY-bound', () => {
    expect(
      resolveTerminalLayoutActiveLeafId({
        root: split(LEAF_1, LEAF_2),
        activeLeafId: LEAF_2,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2' }
      })
    ).toBe(LEAF_2)
  })

  it('repairs a stale active leaf to the first PTY-bound leaf in layout order', () => {
    expect(
      resolveTerminalLayoutActiveLeafId({
        root: split(LEAF_1, LEAF_2),
        activeLeafId: LEAF_1,
        ptyIdsByLeafId: { [LEAF_2]: 'pty-2' }
      })
    ).toBe(LEAF_2)
  })

  it('ignores PTY bindings for leaves outside the layout root', () => {
    expect(
      resolveTerminalLayoutActiveLeafId({
        root: split(LEAF_1, LEAF_2),
        activeLeafId: LEAF_1,
        ptyIdsByLeafId: { [LEAF_3]: 'stale-pty' }
      })
    ).toBe(LEAF_1)
  })

  it('falls back to a valid visual leaf when no PTY-bound leaf remains', () => {
    expect(
      resolveTerminalLayoutActiveLeafId({
        root: split(LEAF_1, LEAF_2),
        activeLeafId: LEAF_2,
        ptyIdsByLeafId: {}
      })
    ).toBe(LEAF_2)
  })
})

describe('normalizeTerminalLayoutSnapshot active leaf repair', () => {
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
})
