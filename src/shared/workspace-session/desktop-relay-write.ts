import type { ExecutionHostId } from '../execution-host/execution-host'
import type { DesktopRelayHostWrite } from './desktop-relay-ownership'

export const DESKTOP_RELAY_WRITE_VERSION = 1

/** The desktop window's relay ids, per host partition, for main to apply by ownership. */
export type DesktopRelayWrite = {
  version: typeof DESKTOP_RELAY_WRITE_VERSION
  hosts: (DesktopRelayHostWrite & { hostId: ExecutionHostId })[]
}

/** A full partition save. `relays: 'separate'`: main keeps its stored relay ids, except that it applies
 *  `carried` (this partition's relay ids) by ownership in the same publish. */
export type WorkspaceSessionSetOptions = {
  relays?: 'separate'
  carried?: DesktopRelayWrite['hosts'][number]
}

/** `relays`: how main took `carried`, absent when nothing was carried or the save was skipped. */
export type WorkspaceSessionSetResult = {
  status: 'applied' | 'skipped'
  relays?: 'applied' | 'unchanged' | 'refused'
}

export type DesktopRelayWriteResult = {
  applied: ExecutionHostId[]
  unchanged: ExecutionHostId[]
  /** Fenced partitions (a frozen source, a held move): nothing changed; resend later. */
  skipped: ExecutionHostId[]
  /** Applied hosts where main kept an id it holds in place of the window's; resend a baseline later. */
  refused: ExecutionHostId[]
}
