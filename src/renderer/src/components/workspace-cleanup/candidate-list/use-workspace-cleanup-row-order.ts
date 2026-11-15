import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'

type HeldRow = { identity: string }

const NO_IDENTITIES: ReadonlySet<string> = new Set()

export type WorkspaceCleanupHeldRowOrder = {
  /** Order is only valid for the reset key it was captured under. */
  key: string
  /** The sort/filter part of `key`; a reset within the same scope may carry rows over. */
  scope: string
  /** Host-qualified identity -> slot. Slots are never reused, so a row keeps its place. */
  positions: ReadonlyMap<string, number>
  /** Next unused slot; never derived from the map size, so released slots are not reused. */
  next: number
}

/** Rows a reset must keep even when they no longer match, placed where they were before. */
export type WorkspaceCleanupHeldRowCarry = {
  keep: ReadonlySet<string>
  previous: WorkspaceCleanupHeldRowOrder
  /** The row still exists (unfiltered); rows deleted elsewhere are never carried. */
  exists: (identity: string) => boolean
}

export function createWorkspaceCleanupHeldRowOrder(
  rows: readonly HeldRow[],
  key: string,
  scope = key,
  carry?: WorkspaceCleanupHeldRowCarry
): WorkspaceCleanupHeldRowOrder {
  const sequence = carry ? withCarriedRows(rows, carry) : rows.map((row) => row.identity)
  return {
    key,
    scope,
    positions: new Map(sequence.map((identity, index) => [identity, index])),
    next: sequence.length
  }
}

/**
 * The live order, plus each kept row that dropped out of it. A carried row goes right before
 * the row that followed it last time, so it keeps its place among its neighbours.
 */
function withCarriedRows(rows: readonly HeldRow[], carry: WorkspaceCleanupHeldRowCarry): string[] {
  const present = new Set(rows.map((row) => row.identity))
  const previous = [...carry.previous.positions]
    .sort((left, right) => left[1] - right[1])
    .map(([identity]) => identity)
  const before = new Map<string | null, string[]>()
  const placed = new Set<string>()
  let anchor: string | null = null
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const identity = previous[index]
    if (present.has(identity)) {
      anchor = identity
    } else if (carry.keep.has(identity) && carry.exists(identity)) {
      const list = before.get(anchor) ?? []
      list.unshift(identity)
      before.set(anchor, list)
      placed.add(identity)
    }
  }
  const sequence: string[] = []
  for (const row of rows) {
    sequence.push(...(before.get(row.identity) ?? []), row.identity)
  }
  sequence.push(...(before.get(null) ?? []))
  for (const identity of carry.keep) {
    if (!present.has(identity) && !placed.has(identity) && carry.exists(identity)) {
      sequence.push(identity)
    }
  }
  return sequence
}

/** The order a render should use: the held one, or the one the next reset will adopt. */
function deriveWorkspaceCleanupHeldRowOrder(
  current: WorkspaceCleanupHeldRowOrder | null,
  liveRows: readonly HeldRow[],
  liveRowByIdentity: ReadonlyMap<string, HeldRow>,
  fullKey: string,
  resetKey: string,
  keepIdentities: ReadonlySet<string>
): WorkspaceCleanupHeldRowOrder {
  if (current !== null && current.key === fullKey) {
    return extendWorkspaceCleanupHeldRowOrder(liveRows, current)
  }
  // Refresh/open/settle resets keep the user's selected rows; a sort or filter change does not,
  // because that is the user's own choice and it prunes the selection with a notice.
  const carry =
    current !== null && current.scope === resetKey && keepIdentities.size > 0
      ? {
          keep: keepIdentities,
          previous: current,
          exists: (identity: string) => liveRowByIdentity.has(identity)
        }
      : undefined
  return createWorkspaceCleanupHeldRowOrder(liveRows, fullKey, resetKey, carry)
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
 * Hold row order for the whole time the dialog is open. Late git/size/agent/review updates
 * refresh row data in place but never move a row. The order is re-derived only when:
 * the sort or filters change (`resetKey`), the dialog opens, a scan starts (Refresh), a
 * scan settles with nothing the user is mid-way through, or `resetOrder()` is called.
 * A reset never drops a row in `keepIdentities` that still exists, even if it stopped matching.
 */
export function useWorkspaceCleanupHeldRows<Row extends HeldRow>({
  liveRows,
  liveRowByIdentity,
  resetKey,
  open,
  loading,
  gitChecking = false,
  keepIdentities = NO_IDENTITIES,
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
  /** Targeted git checks are still running; their completion counts as a settle. */
  gitChecking?: boolean
  /** Rows a reset must keep in place (the selection), resolved from `liveRowByIdentity`. */
  keepIdentities?: ReadonlySet<string>
  /** Read at scan settle: false once the user is mid-selection, scrolling or pointing at rows. */
  shouldResortAtSettle: () => boolean
}): {
  rows: readonly Row[]
  resetOrder: () => void
  /** Forget these rows' slots: they vanish if no longer matching, else reappear at the end. */
  releaseRows: (identities: readonly string[]) => void
} {
  const [epoch, setEpoch] = useState(0)
  const [held, setHeld] = useState<WorkspaceCleanupHeldRowOrder | null>(null)
  const fullKey = `${resetKey}#${epoch}`
  const previousRef = useRef({ open, loading, gitChecking })

  // Only a pending reset reads the selection, so ticking rows does not re-arrange the list.
  const resetPending = held === null || held.key !== fullKey
  const keepForReset = resetPending ? keepIdentities : NO_IDENTITIES
  const rows = useMemo(() => {
    if (held === null) {
      return liveRows
    }
    // A reset applies in this same render, so a kept row is never missing for a frame.
    const order =
      held.key === fullKey
        ? held
        : deriveWorkspaceCleanupHeldRowOrder(
            held,
            liveRows,
            liveRowByIdentity,
            fullKey,
            resetKey,
            keepForReset
          )
    return arrangeWorkspaceCleanupHeldRows(liveRows, liveRowByIdentity, order)
  }, [fullKey, held, keepForReset, liveRowByIdentity, liveRows, resetKey])

  const resetOrder = useCallback(() => setEpoch((current) => current + 1), [])
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
      setEpoch((current) => current + 1)
    }
  }, [gitChecking, loading, open])

  const captureOrder = useEffectEvent(() => {
    // Only committed renders advance the held order.
    setHeld((current) =>
      deriveWorkspaceCleanupHeldRowOrder(
        current,
        liveRows,
        liveRowByIdentity,
        fullKey,
        resetKey,
        keepIdentities
      )
    )
  })
  useEffect(() => {
    captureOrder()
  }, [fullKey, liveRows])

  return { rows, resetOrder, releaseRows }
}
