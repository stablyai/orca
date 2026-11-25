import { createContext } from 'react'
import type {
  WorkerDockEntry,
  WorkerDockSnapshot
} from '../../../../../../../shared/orchestration/dock/worker-dock'

/** Whether a dock row's Stop can run, from the row as it reads now. Rendering and sending share
 *  this rule, so an enabled Stop always sends. Activity the host can't verify does not block it:
 *  a ready or start-unknown worker is still stoppable while its feed is live. */
export function workerDockCanStop(row: {
  state: WorkerDockEntry['state']
  settlement?: string | null
  stoppable: boolean
  ownerActionsAvailable?: boolean
  retired?: boolean
}): boolean {
  const failed = row.state === 'failed' || row.state === 'unexpected'
  // An exited worker with an open dispatch has nothing to clear; Stop settles it.
  const exitedOpen = row.state === 'unexpected' && !row.settlement
  return (
    row.ownerActionsAvailable !== false &&
    !row.retired &&
    (!failed || exitedOpen) &&
    row.stoppable &&
    row.state !== 'saving' &&
    row.state !== 'stopping'
  )
}

/** Why Stop may no longer be sent for the row a Stop or Retry was pressed on: `settled` once that
 *  worker has finished, `blocked` for anything else (another party or worker, a lost feed, or a
 *  row that can't stop now). Null while it may still be sent. */
export type WorkerDockStopBlock = 'settled' | 'blocked' | null

/** Reads the dock as it is now, once per Stop or Retry. The identity is the current state: a
 *  metadata-only update can settle a worker, or start stopping it, without refreshing the row
 *  detail, so the detail supplies only what the identity does not carry. */
export function workerDockStopBlock(
  pressed: Pick<WorkerDockEntry, 'id' | 'dispatchId'>,
  pressedParty: string,
  now: {
    party: string | null | undefined
    available: boolean
    rows: ReadonlyMap<string, WorkerDockEntry>
    identities: WorkerDockSnapshot['identities'] | undefined
  }
): WorkerDockStopBlock {
  if (now.party !== pressedParty) {
    return 'blocked'
  }
  const identity = now.identities?.find((entry) => entry.id === pressed.id)
  if (!identity || identity.dispatchId !== pressed.dispatchId) {
    return 'blocked'
  }
  const detail = now.rows.get(pressed.id)
  const sameDetail = detail?.dispatchId === pressed.dispatchId ? detail : undefined
  // Settlement is final whether or not the detail is still cached.
  if (identity.settlement || sameDetail?.settlement) {
    return 'settled'
  }
  if (!now.available || !sameDetail) {
    return 'blocked'
  }
  return workerDockCanStop({
    ...sameDetail,
    state: identity.state,
    ownerActionsAvailable:
      identity.ownerActionsAvailable !== false && sameDetail.ownerActionsAvailable !== false
  })
    ? null
    : 'blocked'
}

/** The dock feed's live loss count. A Stop press reads it when it starts and again when it
 *  activates; any loss in between cancels that press, even after the feed recovers. */
export const WorkerDockFeedLossesContext = createContext<() => number>(() => 0)
