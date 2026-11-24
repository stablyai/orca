import type {
  WorkerDockEntry,
  WorkerDockSnapshot
} from '../../../../../../../shared/orchestration/dock/worker-dock'

type StopCheckRow = Pick<WorkerDockEntry, 'id' | 'dispatchId'>

/** Why Stop may no longer be sent for the row a Stop or Retry was pressed on: `settled` once that
 *  worker has finished, `blocked` for anything else (another party, worker or owner, or no live
 *  status). Null while it may still be sent. */
export type WorkerDockStopBlock = 'settled' | 'blocked' | null

/** Reads the dock as it is now. The identity is checked as well as the row detail because a
 *  metadata-only update can settle a worker without refreshing its detail. */
export function workerDockStopBlock(
  pressed: StopCheckRow,
  pressedParty: string,
  now: {
    party: string | null | undefined
    rows: ReadonlyMap<string, WorkerDockEntry>
    identities: WorkerDockSnapshot['identities'] | undefined
  }
): WorkerDockStopBlock {
  if (now.party !== pressedParty) {
    return 'blocked'
  }
  const identity = now.identities?.find((entry) => entry.id === pressed.id)
  const detail = now.rows.get(pressed.id)
  if (
    !identity ||
    !detail ||
    identity.dispatchId !== pressed.dispatchId ||
    detail.dispatchId !== pressed.dispatchId
  ) {
    return 'blocked'
  }
  if (identity.settlement || detail.settlement) {
    return 'settled'
  }
  return identity.state !== 'failed' &&
    identity.state !== 'saving' &&
    identity.state !== 'unavailable' &&
    identity.ownerActionsAvailable !== false &&
    detail.ownerActionsAvailable !== false &&
    detail.stoppable
    ? null
    : 'blocked'
}
