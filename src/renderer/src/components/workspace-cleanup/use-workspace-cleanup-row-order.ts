import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { WorkspaceCleanupSortState } from '../../../../shared/workspace-cleanup-filter-model'

type OrderedRow = { worktreeId: string }

export type WorkspaceCleanupFrozenRowOrder = {
  sortSignature: string
  positions: Map<string, number>
}

const UNCOMMITTED_ROW_ORDER: WorkspaceCleanupFrozenRowOrder = {
  sortSignature: '',
  positions: new Map()
}

export function createWorkspaceCleanupFrozenRowOrder(
  rows: readonly OrderedRow[],
  sortSignature: string
): WorkspaceCleanupFrozenRowOrder {
  return {
    sortSignature,
    positions: new Map(rows.map((row, index) => [row.worktreeId, index]))
  }
}

/** Keep visible rows in place while streaming; append new rows in their current sort order, then retain those slots too. */
export function arrangeWorkspaceCleanupRowsByFrozenOrder<Row extends OrderedRow>(
  sortedRows: readonly Row[],
  order: WorkspaceCleanupFrozenRowOrder
): Row[] {
  const known: Row[] = []
  const fresh: Row[] = []
  for (const row of sortedRows) {
    if (order.positions.has(row.worktreeId)) {
      known.push(row)
    } else {
      fresh.push(row)
    }
  }
  known.sort(
    (left, right) =>
      (order.positions.get(left.worktreeId) ?? 0) - (order.positions.get(right.worktreeId) ?? 0)
  )
  return [...known, ...fresh]
}

export function extendWorkspaceCleanupFrozenRowOrder(
  rows: readonly OrderedRow[],
  order: WorkspaceCleanupFrozenRowOrder
): WorkspaceCleanupFrozenRowOrder {
  let positions: Map<string, number> | null = null
  for (const row of rows) {
    if (order.positions.has(row.worktreeId)) {
      continue
    }
    positions ??= new Map(order.positions)
    if (!positions.has(row.worktreeId)) {
      positions.set(row.worktreeId, positions.size)
    }
  }
  return positions === null ? order : { ...order, positions }
}

/** Apply sort immediately, hold row positions during streaming, then resort once at settlement or explicit sort change. */
export function useWorkspaceCleanupRowOrder<Row extends OrderedRow>({
  rows,
  streaming,
  sort
}: {
  rows: readonly Row[]
  streaming: boolean
  sort: WorkspaceCleanupSortState
}): readonly Row[] {
  // Render reads React-owned order state; idle capture stays in commit-only refs to avoid mixing concurrent render passes.
  const [frozenOrder, setFrozenOrder] =
    useState<WorkspaceCleanupFrozenRowOrder>(UNCOMMITTED_ROW_ORDER)
  const idleOrderRef = useRef<WorkspaceCleanupFrozenRowOrder>(UNCOMMITTED_ROW_ORDER)
  const sortSignature = `${sort.field}:${sort.direction}`
  const orderedRows = useMemo(
    () =>
      !streaming || frozenOrder.sortSignature !== sortSignature
        ? rows
        : arrangeWorkspaceCleanupRowsByFrozenOrder(rows, frozenOrder),
    [frozenOrder, rows, sortSignature, streaming]
  )
  const commitFrozenOrder = useEffectEvent(() => {
    // Why: only committed renders may advance the order a later stream holds.
    if (!streaming) {
      idleOrderRef.current = createWorkspaceCleanupFrozenRowOrder(rows, sortSignature)
      setFrozenOrder((current) =>
        current === UNCOMMITTED_ROW_ORDER ? current : UNCOMMITTED_ROW_ORDER
      )
      return
    }
    setFrozenOrder((current) => {
      const base =
        current !== UNCOMMITTED_ROW_ORDER && current.sortSignature === sortSignature
          ? current
          : idleOrderRef.current.sortSignature === sortSignature
            ? idleOrderRef.current
            : createWorkspaceCleanupFrozenRowOrder(rows, sortSignature)
      return extendWorkspaceCleanupFrozenRowOrder(rows, base)
    })
  })
  useEffect(() => {
    commitFrozenOrder()
  }, [rows, sortSignature, streaming])
  return orderedRows
}
