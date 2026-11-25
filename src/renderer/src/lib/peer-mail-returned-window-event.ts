import { hostWindowEvent } from './host-window-event'

/** A host's paired computer handed back replies to its agents' asks, so their cards re-read; with
 *  or without bots on that host. */
const peerMailReturned = hostWindowEvent('orca:peer-mail-returned')

export const emitPeerMailReturnedWindowEvent = peerMailReturned.emit
export const onPeerMailReturned = peerMailReturned.on
