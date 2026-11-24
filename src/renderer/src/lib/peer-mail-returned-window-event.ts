import {
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'

/** A host's paired computer handed back replies to its agents' asks, so their cards re-read; with
 *  or without bots on that host. */
const PEER_MAIL_RETURNED_EVENT = 'orca:peer-mail-returned'

export function emitPeerMailReturnedWindowEvent(hostId: ExecutionHostId): void {
  window.dispatchEvent(new CustomEvent(PEER_MAIL_RETURNED_EVENT, { detail: { hostId } }))
}

export function onPeerMailReturned(listener: () => void, hostId: ExecutionHostId): () => void {
  const handle = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
    if (
      detail &&
      typeof detail === 'object' &&
      'hostId' in detail &&
      typeof detail.hostId === 'string' &&
      normalizeExecutionHostId(detail.hostId) === hostId
    ) {
      listener()
    }
  }
  window.addEventListener(PEER_MAIL_RETURNED_EVENT, handle)
  return () => window.removeEventListener(PEER_MAIL_RETURNED_EVENT, handle)
}
