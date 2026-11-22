import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type {
  DesktopRelayWrite,
  DesktopRelayWriteResult,
  WorkspaceSessionSetOptions,
  WorkspaceSessionSetResult
} from '../../../../../shared/workspace-session/desktop-relay-write'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { nonLocalHostSessionEntries, type HostSessionSlices } from './workspace-session-host-split'
import type { SessionRelevantField } from './workspace-session'
import { carriedRelayAnswer, type CarriedRelayStatus } from './workspace-session-host-entries-write'
import {
  forgetAcknowledgedDesktopRelays,
  narrowDesktopRelayWrite,
  type DesktopRelayApi
} from './desktop-relay-writes'

// A ptyIdsByTabId change rebuilds every host's relay ids on the next save; refused hosts retry then.
const SEAM_RELAY_RETRY_FIELDS = ['ptyIdsByTabId'] as const satisfies readonly SessionRelevantField[]

/** A write main accepted but could not fully apply (a fenced partition, a refused id): resend these fields later. */
export type SessionWriteOutcome = { pendingFields?: readonly SessionRelevantField[] }

export function relayWriteOutcome(
  result: DesktopRelayWriteResult | null | undefined
): SessionWriteOutcome | void {
  return result?.skipped.length || result?.refused.length
    ? { pendingFields: SEAM_RELAY_RETRY_FIELDS }
    : undefined
}

/** One save's relay write, narrowed once: hosts that ride with their entries patch, and the rest
 *  sent separately; main's answers for both are acknowledged together. */
export type DesktopRelayPlan = {
  carried: ReadonlyMap<ExecutionHostId, DesktopRelayWrite['hosts'][number]>
  sendRest: () => Promise<DesktopRelayWriteResult> | null
  /** The combined answer, from the settled entries writes and the separate write. */
  settle: (values: readonly unknown[]) => DesktopRelayWriteResult
  forget: () => void
}

/** The hosts a save writes a partition for: local always, others when it has their slice. */
export function slicedHostIds(slices: HostSessionSlices): Set<ExecutionHostId> {
  return new Set([
    LOCAL_EXECUTION_HOST_ID,
    ...nonLocalHostSessionEntries(slices).map(([hostId]) => hostId)
  ])
}

export function planDesktopRelayWrite(
  api: DesktopRelayApi,
  full: DesktopRelayWrite,
  // Hosts whose partition write in this save carries their relay ids; the rest go separately.
  carriable: ReadonlySet<ExecutionHostId>
): DesktopRelayPlan | null {
  const applyDesktopRelays = api.applyDesktopRelays
  if (!applyDesktopRelays) {
    return null
  }
  const { write, acknowledge } = narrowDesktopRelayWrite(full)
  if (write.hosts.length === 0) {
    return null
  }
  const carried = new Map<ExecutionHostId, DesktopRelayWrite['hosts'][number]>()
  const rest: DesktopRelayWrite['hosts'] = []
  for (const host of write.hosts) {
    if (carriable.has(host.hostId)) {
      carried.set(host.hostId, host)
    } else {
      rest.push(host)
    }
  }
  return {
    carried,
    sendRest: () =>
      rest.length > 0 ? applyDesktopRelays({ version: write.version, hosts: rest }) : null,
    settle: (values) => {
      const result: DesktopRelayWriteResult = {
        applied: [],
        unchanged: [],
        skipped: [],
        refused: []
      }
      for (const value of values) {
        if (isCarriedRelayStatus(value)) {
          const { hostId, relays } = value
          result[relays === 'refused' ? 'applied' : relays].push(hostId)
          if (relays === 'refused') {
            result.refused.push(hostId)
          }
        } else if (isDesktopRelayWriteResult(value)) {
          for (const key of ['applied', 'unchanged', 'skipped', 'refused'] as const) {
            result[key].push(...value[key])
          }
        }
      }
      acknowledge(result)
      return result
    },
    forget: forgetAcknowledgedDesktopRelays
  }
}

/** Every partition write finishes before a retry rewrites the same fields; a failure rejects (and
 *  drops what main accepted of the relay ids), else skipped or refused relay hosts stay pending. */
export function settleSessionWrites(
  writes: readonly (Promise<unknown> | null | undefined)[],
  relayPlan: DesktopRelayPlan | null | undefined
): Promise<SessionWriteOutcome | void> {
  const settled = writes.map((write) => write ?? Promise.resolve(undefined))
  return Promise.allSettled(settled).then((results) => {
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) {
      relayPlan?.forget()
      throw failure.reason
    }
    return relayWriteOutcome(
      relayPlan?.settle(
        results.map((result) => (result.status === 'fulfilled' ? result.value : null))
      )
    )
  })
}

export type SnapshotSetApi = DesktopRelayApi & {
  set: (
    args: WorkspaceSessionState,
    hostId?: ExecutionHostId,
    options?: WorkspaceSessionSetOptions
  ) => Promise<WorkspaceSessionSetResult | void>
}

/** Full snapshots, each carrying its host's relay ids so main publishes them together once; other
 *  relay hosts go separately in the same turn, so a later save's relay write can't overtake them. */
export function setSnapshotsWithRelays(
  api: SnapshotSetApi,
  snapshots: readonly { state: WorkspaceSessionState; hostId?: ExecutionHostId }[],
  desktopRelays: DesktopRelayWrite | null
): Promise<SessionWriteOutcome | void> {
  const relayPlan =
    desktopRelays &&
    planDesktopRelayWrite(
      api,
      desktopRelays,
      new Set(snapshots.map((s) => s.hostId ?? LOCAL_EXECUTION_HOST_ID))
    )
  const sets = snapshots.map((s) => {
    const hostId = s.hostId ?? LOCAL_EXECUTION_HOST_ID
    const carried = relayPlan?.carried.get(hostId)
    const options = desktopRelays ? { relays: 'separate' as const, carried } : {}
    return api.set(s.state, s.hostId, options).then((r) => carriedRelayAnswer(hostId, carried, r))
  })
  return settleSessionWrites([...sets, relayPlan?.sendRest()], relayPlan)
}

function isCarriedRelayStatus(value: unknown): value is CarriedRelayStatus {
  return typeof value === 'object' && value !== null && 'relays' in value && 'hostId' in value
}

function isDesktopRelayWriteResult(value: unknown): value is DesktopRelayWriteResult {
  return typeof value === 'object' && value !== null && 'applied' in value && 'refused' in value
}
