import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'

type HeldRow = { identity: string }

export type WorkspaceCleanupHeldRowOrder = {
  /** Order is only valid for the reset key it was captured under. */
  key: string
  /** Host-qualified identity -> slot. Slots are never reused, so a row keeps its place. */
  positions: ReadonlyMap<string, number>
}

export function createWorkspaceCleanupHeldRowOrder(
  rows: readonly HeldRow[],
  key: string
): WorkspaceCleanupHeldRowOrder {
  return {
    key,
    positions: new Map(rows.map((row, index) => [row.identity, index]))
  }
}

/** Rows that first appear later take the next free slot, so they land at the end. */
export function extendWorkspaceCleanupHeldRowOrder(
  rows: readonly HeldRow[],
  order: WorkspaceCleanupHeldRowOrder
): WorkspaceCleanupHeldRowOrder {
  let positions: Map<string, number> | null = null
  for (const row of rows) {
    if (order.positions.has(row.identity)) {
      continue
    }
    positions ??= new Map(order.positions)
    positions.set(row.identity, positions.size)
  }
  return positions === null ? order : { ...order, positions }
}

/**
 * Lay out rows in their held slots using each row's CURRENT data. A row that left the
 * filtered result but still exists stays in place; a row that no longer exists drops out;
 * rows without a slot follow in the current sort order.
 */
export function arrangeWorkspaceCleanupHeldRows<Row extends HeldRow>(
  liveRows: readonly Row[],
  liveRowByIdentity: ReadonlyMap<string, Row>,
  order: WorkspaceCleanupHeldRowOrder
): Row[] {
  const held: { row: Row; slot: number }[] = []
  for (const [identity, slot] of order.positions) {
    const row = liveRowByIdentity.get(identity)
    if (row !== undefined) {
      held.push({ row, slot })
    }
  }
  held.sort((left, right) => left.slot - right.slot)
  const arranged = held.map((entry) => entry.row)
  // Only rows that matched at some point hold a slot; unseen matches append in sort order.
  for (const row of liveRows) {
    if (!order.positions.has(row.identity)) {
      arranged.push(row)
    }
  }
  return arranged
}

/**
 * Hold row order for the whole time the dialog is open. Late git/size/agent/review updates
 * refresh row data in place but never move a row. The order is re-derived only when:
 * the sort or filters change (`resetKey`), the dialog opens, a scan starts (Refresh), a
 * scan settles with nothing the user is mid-way through, or `resetOrder()` is called.
 */
export function useWorkspaceCleanupHeldRows<Row extends HeldRow>({
  liveRows,
  liveRowByIdentity,
  resetKey,
  open,
  loading,
  shouldResortAtSettle
}: {
  /** Query result in the active sort; the order a reset adopts. */
  liveRows: readonly Row[]
  /** Every candidate's live row (unfiltered), so held rows keep updating. */
  liveRowByIdentity: ReadonlyMap<string, Row>
  /** Changes when the sort, filters or search change. */
  resetKey: string
  open: boolean
  loading: boolean
  /** Read at scan settle: false once the user is mid-selection, scrolling or pointing at rows. */
  shouldResortAtSettle: () => boolean
}): { rows: readonly Row[]; resetOrder: () => void } {
  const [epoch, setEpoch] = useState(0)
  const [held, setHeld] = useState<WorkspaceCleanupHeldRowOrder | null>(null)
  const fullKey = `${resetKey}#${epoch}`
  const previousRef = useRef({ open, loading })

  const rows = useMemo(
    () =>
      held === null || held.key !== fullKey
        ? liveRows
        : arrangeWorkspaceCleanupHeldRows(liveRows, liveRowByIdentity, held),
    [fullKey, held, liveRowByIdentity, liveRows]
  )

  const resetOrder = useCallback(() => setEpoch((current) => current + 1), [])
  const readSettlePolicy = useEffectEvent(() => shouldResortAtSettle())
  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { open, loading }
    const opened = open && !previous.open
    const scanStarted = open && loading && !previous.loading
    const scanSettled = open && !loading && previous.loading && readSettlePolicy()
    if (opened || scanStarted || scanSettled) {
      setEpoch((current) => current + 1)
    }
  }, [loading, open])

  const captureOrder = useEffectEvent(() => {
    // Only committed renders advance the held order.
    setHeld((current) =>
      current !== null && current.key === fullKey
        ? extendWorkspaceCleanupHeldRowOrder(liveRows, current)
        : createWorkspaceCleanupHeldRowOrder(liveRows, fullKey)
    )
  })
  useEffect(() => {
    captureOrder()
  }, [fullKey, liveRows])

  return { rows, resetOrder }
}
