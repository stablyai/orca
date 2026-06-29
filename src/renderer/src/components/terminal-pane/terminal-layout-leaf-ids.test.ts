import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'
import {
  normalizeTerminalLayoutSnapshot,
  resolvePtyBoundActiveLeafId,
  resolveTerminalLayoutActiveLeafId
} from './terminal-layout-leaf-ids'

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
  it('preserves a rootless active leaf before terminal replay', () => {
    const result = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: LEAF_1,
      expandedLeafId: null
    })

    expect(result.changed).toBe(false)
    expect(result.snapshot.activeLeafId).toBe(LEAF_1)
  })

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

  it('uses a sole rootless PTY binding when no active leaf remains', () => {
    const result = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_2]: 'pty-2'
      }
    })

    expect(result.changed).toBe(true)
    expect(result.snapshot.activeLeafId).toBe(LEAF_2)
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

  it('preserves valid active and expanded leaf ids', () => {
    const layout = splitLayout()

    const normalized = normalizeTerminalLayoutSnapshot(layout)

    expect(normalized.changed).toBe(false)
    expect(normalized.snapshot.activeLeafId).toBe(LEAF_2)
    expect(normalized.snapshot.expandedLeafId).toBe(LEAF_3)
  })
})

describe('resolvePtyBoundActiveLeafId', () => {
  it('preserves the active leaf when it still has a PTY binding', () => {
    const layout = splitLayout()

    const activeLeafId = resolvePtyBoundActiveLeafId({
      root: layout.root,
      activeLeafId: LEAF_2,
      ptyIdsByLeafId: layout.ptyIdsByLeafId
    })

    expect(activeLeafId).toBe(LEAF_2)
  })

  it('moves active selection to the first bound layout leaf when the active PTY is gone', () => {
    const layout = splitLayout()

    const activeLeafId = resolvePtyBoundActiveLeafId({
      root: layout.root,
      activeLeafId: LEAF_2,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-1',
        [LEAF_3]: 'pty-3'
      }
    })

    expect(activeLeafId).toBe(LEAF_1)
  })

  it('falls back to the current active leaf when no PTY bindings exist', () => {
    const layout = splitLayout()

    const activeLeafId = resolvePtyBoundActiveLeafId({
      root: layout.root,
      activeLeafId: LEAF_2,
      ptyIdsByLeafId: undefined
    })

    expect(activeLeafId).toBe(LEAF_2)
  })

  it('uses a binding key when there is no root layout to inspect', () => {
    const activeLeafId = resolvePtyBoundActiveLeafId({
      root: null,
      activeLeafId: null,
      ptyIdsByLeafId: { [LEAF_3]: 'pty-3' }
    })

    expect(activeLeafId).toBe(LEAF_3)
  })
})
