import { useCallback, useMemo, useState } from 'react'
import type { WorkerDockRowView } from './WorkerDockRow'
import { workerDockIsAgentKind } from './worker-dock-labels'
import { compareWorkerDockCardRows } from './worker-dock-card-order'
import type { WorkerDockStopAllScope } from './WorkerDockCardFooter'

export type WorkerDockIdentity = {
  id: string
  /** Absent on an orchestration worker's identity. */
  kind?: string
  state: WorkerDockRowView['state']
  changedAt?: number | null
  ownerActionsAvailable?: boolean
  settlement?: string | null
}

type Rows = ReadonlyMap<string, WorkerDockRowView>

function kindOf(row: WorkerDockIdentity, rows: Rows): string {
  return row.kind ?? rows.get(row.id)?.kind ?? 'worker'
}

/** The card's rows: agents first, then background commands, each in the card's own order. A held
 *  order keeps rows from jumping under the pointer, but never keeps a row that left and never hides
 *  one that arrived: it joins the end of its own group, so a new agent never lands under the
 *  commands. The label sits inside the first command row, so row indices, keyboard moves, scroll
 *  anchors and detail reads all stay one-per-row. */
export function useWorkerDockGroupedOrder(identities: readonly WorkerDockIdentity[], rows: Rows) {
  const isCommand = useCallback(
    (row: WorkerDockIdentity) => !workerDockIsAgentKind(kindOf(row, rows)),
    [rows]
  )
  const sorted = useMemo(
    () =>
      [...identities].sort(
        (a, b) =>
          Number(isCommand(a)) - Number(isCommand(b)) ||
          compareWorkerDockCardRows(
            { ...a, retired: rows.get(a.id)?.retired },
            { ...b, retired: rows.get(b.id)?.retired }
          )
      ),
    [identities, rows, isCommand]
  )
  const [held, setHeld] = useState<readonly WorkerDockIdentity[] | null>(null)
  const current = useMemo(() => new Map(sorted.map((row) => [row.id, row])), [sorted])
  const items = useMemo(() => {
    if (!held) {
      return sorted
    }
    const kept = held.flatMap((row) => current.get(row.id) ?? [])
    const keptIds = new Set(kept.map((row) => row.id))
    const merged = [...kept, ...sorted.filter((row) => !keptIds.has(row.id))]
    return [...merged.filter((row) => !isCommand(row)), ...merged.filter(isCommand)]
  }, [held, sorted, current, isCommand])
  if (
    held &&
    (held.length !== items.length || held.some((row, index) => row.id !== items[index].id))
  ) {
    setHeld(items)
  }
  const workers = items.filter((row) => !isCommand(row)).length
  return {
    sorted,
    items,
    setHeld,
    isCommand,
    counts: { workers, commands: items.length - workers }
  }
}

/** The pill names the most pressing row of either group: a failed command outranks a running agent. */
export function workerDockTopRow(
  identities: readonly WorkerDockIdentity[],
  rows: Rows
): WorkerDockIdentity | undefined {
  return identities.reduce<WorkerDockIdentity | undefined>(
    (best, row) =>
      !best ||
      compareWorkerDockCardRows(
        { ...row, retired: rows.get(row.id)?.retired },
        { ...best, retired: rows.get(best.id)?.retired }
      ) < 0
        ? row
        : best,
    undefined
  )
}

/** Stop all is the chat's own untargeted stop: it names no target, so it ends whatever subagents and
 *  commands the chat runs when it lands, listed or not, and never orchestration workers. With workers
 *  listed beside it, it says so ("Stop subagents and commands"); otherwise it is plain "Stop all". */
export function workerDockStopAllScope(
  items: readonly WorkerDockIdentity[],
  rows: Rows
): WorkerDockStopAllScope {
  return items.some((row) => kindOf(row, rows) === 'worker') ? 'subagents-and-commands' : 'all'
}
