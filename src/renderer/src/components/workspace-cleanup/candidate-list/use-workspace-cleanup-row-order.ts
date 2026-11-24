import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'

type HeldRow = { identity: string }

export type WorkspaceCleanupHeldRowOrder = {
  /** Order is only valid for the reset key it was captured under. */
  key: string
  /** Host-qualified identity -> slot. Slots are never reused, so a row keeps its place. */
  positions: ReadonlyMap<string, number>
  /** Next unused slot; never derived from the map size, so released slots are not reused. */
  next: number
  /** Filter/search state the order was captured under; a different key means a filter change. */
  filterKey?: string
}

export function createWorkspaceCleanupHeldRowOrder(
  rows: readonly HeldRow[],
  key: string
): WorkspaceCleanupHeldRowOrder {
  return {
    key,
    positions: new Map(rows.map((row, index) => [row.identity, index])),
    next: rows.length
  }
}

/** Rows that first appear later take the next free slot, so they land at the end. */
export function extendWorkspaceCleanupHeldRowOrder(
  rows: readonly HeldRow[],
  order: WorkspaceCleanupHeldRowOrder
): WorkspaceCleanupHeldRowOrder {
  let positions: Map<string, number> | null = null
  let next = order.next
  for (const row of rows) {
    if (order.positions.has(row.identity)) {
      continue
    }
    positions ??= new Map(order.positions)
    positions.set(row.identity, next)
    next += 1
  }
  return positions === null ? order : { ...order, positions, next }
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
 * Rebuild the order on a reset. Selected rows that still exist keep the place they had on screen,
 * even when late evidence has filtered them out; unselected rows take the live sort.
 */
export function createWorkspaceCleanupResetOrder<Row extends HeldRow>({
  liveRows,
  displayedRows,
  liveRowByIdentity,
  pinnedIdentities,
  key
}: {
  liveRows: readonly Row[]
  displayedRows: readonly Row[]
  liveRowByIdentity: ReadonlyMap<string, Row>
  pinnedIdentities: ReadonlySet<string>
  key: string
}): WorkspaceCleanupHeldRowOrder {
  const pinned: { row: Row; index: number }[] = []
  displayedRows.forEach((displayed, index) => {
    if (!pinnedIdentities.has(displayed.identity)) {
      return
    }
    const live = liveRowByIdentity.get(displayed.identity)
    if (live !== undefined) {
      pinned.push({ row: live, index })
    }
  })
  const pinnedIds = new Set(pinned.map((entry) => entry.row.identity))
  const rest = liveRows.filter((row) => !pinnedIds.has(row.identity))
  const arranged: Row[] = []
  let nextPinned = 0
  let nextRest = 0
  for (;;) {
    const pin = pinned[nextPinned]
    const restRow = rest[nextRest]
    if (pin !== undefined && (pin.index <= arranged.length || restRow === undefined)) {
      arranged.push(pin.row)
      nextPinned += 1
    } else if (restRow !== undefined) {
      arranged.push(restRow)
      nextRest += 1
    } else {
      break
    }
  }
  return createWorkspaceCleanupHeldRowOrder(arranged, key)
}

const NO_PINNED_IDENTITIES: ReadonlySet<string> = new Set()

/**
 * Hold row order for the whole time the dialog is open. Late git/size/agent/review updates
 * refresh row data in place but never move a row. The order is re-derived only when:
 * the sort or filters change (`resetKey`), the dialog opens, a scan starts (Refresh), a
 * scan settles with nothing the user is mid-way through, or `resetOrder()` is called.
 * A sort-only change or a reset keeps selected rows in place; a filter or search change does not.
 */
export function useWorkspaceCleanupHeldRows<Row extends HeldRow>({
  liveRows,
  liveRowByIdentity,
  resetKey,
  filterKey,
  open,
  loading,
  gitChecking = false,
  pinnedIdentities = NO_PINNED_IDENTITIES,
  shouldResortAtSettle
}: {
  /** Query result in the active sort; the order a reset adopts. */
  liveRows: readonly Row[]
  /** Every candidate's live row (unfiltered), so held rows keep updating. */
  liveRowByIdentity: ReadonlyMap<string, Row>
  /** Changes when the sort, filters or search change. */
  resetKey: string
  /** Changes only when the filters or search change; a sort-only change keeps the same value. */
  filterKey: string
  open: boolean
  loading: boolean
  /** Targeted git checks are still running; their completion counts as a settle. */
  gitChecking?: boolean
  /** Selected rows; a reset keeps those that still exist in their displayed place. */
  pinnedIdentities?: ReadonlySet<string>
  /** Read at scan settle: false once the user is mid-selection, scrolling or pointing at rows. */
  shouldResortAtSettle: () => boolean
}): {
  rows: readonly Row[]
  resetOrder: () => void
  /** Forget these rows' slots: they vanish if no longer matching, else reappear at the end. */
  releaseRows: (identities: readonly string[]) => void
} {
  const [resetRequest, setResetRequest] = useState(0)
  const [held, setHeld] = useState<WorkspaceCleanupHeldRowOrder | null>(null)
  const previousRef = useRef({ open, loading, gitChecking })
  const appliedFilterKeyRef = useRef(filterKey)

  const rows = useMemo(() => {
    if (held === null) {
      return liveRows
    }
    if (held.key === resetKey) {
      return arrangeWorkspaceCleanupHeldRows(liveRows, liveRowByIdentity, held)
    }
    if (held.filterKey !== filterKey) {
      return liveRows
    }
    // Sort-only change: carry selected rows in this same commit, not after a passive effect.
    const carried = createWorkspaceCleanupResetOrder({
      liveRows,
      displayedRows: arrangeWorkspaceCleanupHeldRows(liveRows, liveRowByIdentity, held),
      liveRowByIdentity,
      pinnedIdentities,
      key: resetKey
    })
    return arrangeWorkspaceCleanupHeldRows(liveRows, liveRowByIdentity, carried)
  }, [filterKey, held, liveRowByIdentity, liveRows, pinnedIdentities, resetKey])

  const [releaseCount, setReleaseCount] = useState(0)
  const resetOrder = useCallback(() => setResetRequest((current) => current + 1), [])
  const releaseRows = useCallback((identities: readonly string[]) => {
    setHeld((current) => {
      if (current === null || !identities.some((identity) => current.positions.has(identity))) {
        return current
      }
      const positions = new Map(current.positions)
      for (const identity of identities) {
        positions.delete(identity)
      }
      return { ...current, positions }
    })
    setReleaseCount((current) => current + 1)
  }, [])
  const readSettlePolicy = useEffectEvent(() => shouldResortAtSettle())
  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { open, loading, gitChecking }
    const opened = open && !previous.open
    const scanStarted = open && loading && !previous.loading
    const scanSettled = open && !loading && previous.loading
    const gitSettled = open && !loading && !gitChecking && previous.gitChecking
    const settledNow = (scanSettled || gitSettled) && readSettlePolicy()
    if (opened || scanStarted || settledNow) {
      setResetRequest((current) => current + 1)
    }
  }, [gitChecking, loading, open])

  // Reads the rows on screen for this render, so a reset keeps the selected rows where they are.
  const applyReset = useEffectEvent(() => {
    setHeld({
      ...createWorkspaceCleanupResetOrder({
        liveRows,
        displayedRows: rows,
        liveRowByIdentity,
        pinnedIdentities,
        key: resetKey
      }),
      filterKey
    })
  })
  useEffect(() => {
    if (resetRequest > 0) {
      applyReset()
    }
  }, [resetRequest])

  const captureOrder = useEffectEvent(() => {
    const filterChanged = appliedFilterKeyRef.current !== filterKey
    appliedFilterKeyRef.current = filterKey
    // Only committed renders advance the held order.
    setHeld((current) => {
      if (current !== null && current.key === resetKey) {
        return extendWorkspaceCleanupHeldRowOrder(liveRows, current)
      }
      if (current !== null && !filterChanged) {
        return {
          ...createWorkspaceCleanupResetOrder({
            liveRows,
            displayedRows: rows,
            liveRowByIdentity,
            pinnedIdentities,
            key: resetKey
          }),
          filterKey
        }
      }
      return { ...createWorkspaceCleanupHeldRowOrder(liveRows, resetKey), filterKey }
    })
  })
  // Released rows that still match take their end slot now, not at the next live-row change.
  useEffect(() => {
    captureOrder()
  }, [resetKey, liveRows, releaseCount])

  return { rows, resetOrder, releaseRows }
}
