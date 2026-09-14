// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  arrangeWorkspaceCleanupRowsByFrozenOrder,
  createWorkspaceCleanupFrozenRowOrder,
  extendWorkspaceCleanupFrozenRowOrder,
  useWorkspaceCleanupRowOrder
} from './use-workspace-cleanup-row-order'
import type { WorkspaceCleanupSortState } from '../../../../shared/workspace-cleanup-filter-model'

type Row = { worktreeId: string }

const row = (worktreeId: string): Row => ({ worktreeId })
const ids = (rows: readonly Row[]): string[] => rows.map((entry) => entry.worktreeId)
const ascending: WorkspaceCleanupSortState = { field: 'name', direction: 'asc' }

describe('workspace cleanup streaming row order', () => {
  it('keeps existing rows in their frozen slots when streamed values would resort them', () => {
    const order = createWorkspaceCleanupFrozenRowOrder([row('a'), row('b'), row('c')], 'name:asc')

    // The live sort now says c < a < b (values changed mid-stream).
    const arranged = arrangeWorkspaceCleanupRowsByFrozenOrder([row('c'), row('a'), row('b')], order)

    expect(ids(arranged)).toEqual(['a', 'b', 'c'])
  })

  it('appends unseen rows after the frozen ones and keeps them stable on later ticks', () => {
    const order = createWorkspaceCleanupFrozenRowOrder([row('a'), row('b')], 'name:asc')

    const firstRows = [row('a'), row('d'), row('b'), row('c')]
    const firstTick = arrangeWorkspaceCleanupRowsByFrozenOrder(firstRows, order)
    expect(ids(firstTick)).toEqual(['a', 'b', 'd', 'c'])
    const extendedOrder = extendWorkspaceCleanupFrozenRowOrder(firstRows, order)

    // A later tick sorting d and c differently must not swap them anymore.
    const secondTick = arrangeWorkspaceCleanupRowsByFrozenOrder(
      [row('c'), row('d'), row('b'), row('a')],
      extendedOrder
    )
    expect(ids(secondTick)).toEqual(['a', 'b', 'd', 'c'])
    expect(order.positions.has('d')).toBe(false)
  })

  it('holds slots for rows a filter temporarily hides', () => {
    const order = createWorkspaceCleanupFrozenRowOrder([row('a'), row('b'), row('c')], 'name:asc')

    expect(ids(arrangeWorkspaceCleanupRowsByFrozenOrder([row('c'), row('a')], order))).toEqual([
      'a',
      'c'
    ])
    // Un-hiding b restores its original slot between a and c.
    expect(
      ids(arrangeWorkspaceCleanupRowsByFrozenOrder([row('c'), row('b'), row('a')], order))
    ).toEqual(['a', 'b', 'c'])
  })

  it('grows the frozen order from empty during a cold-start stream', () => {
    const order = createWorkspaceCleanupFrozenRowOrder([], 'name:asc')
    const firstRows = [row('b'), row('d')]

    expect(ids(arrangeWorkspaceCleanupRowsByFrozenOrder(firstRows, order))).toEqual(['b', 'd'])
    const extendedOrder = extendWorkspaceCleanupFrozenRowOrder(firstRows, order)
    // New rows slot after the already-presented ones even when they sort earlier.
    expect(
      ids(
        arrangeWorkspaceCleanupRowsByFrozenOrder(
          [row('a'), row('b'), row('c'), row('d')],
          extendedOrder
        )
      )
    ).toEqual(['b', 'd', 'a', 'c'])
  })

  it('commits appended positions after each rendered stream tick', () => {
    const view = renderHook(
      ({ rows, streaming }: { rows: readonly Row[]; streaming: boolean }) =>
        useWorkspaceCleanupRowOrder({ rows, streaming, sort: ascending }),
      { initialProps: { rows: [row('a'), row('b')], streaming: false } }
    )

    view.rerender({ rows: [row('a'), row('d'), row('b'), row('c')], streaming: true })
    expect(ids(view.result.current)).toEqual(['a', 'b', 'd', 'c'])

    view.rerender({ rows: [row('c'), row('d'), row('b'), row('a')], streaming: true })
    expect(ids(view.result.current)).toEqual(['a', 'b', 'd', 'c'])
  })
})
