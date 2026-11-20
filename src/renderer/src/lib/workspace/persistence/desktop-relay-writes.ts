import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { workspaceSessionPartitionHostId } from '../../../../../shared/workspace-session/workspace-session-partition-owner'
import {
  DESKTOP_RELAY_WRITE_VERSION,
  type DesktopRelayWrite,
  type DesktopRelayWriteResult
} from '../../../../../shared/workspace-session/desktop-relay-write'
import { nonLocalHostSessionEntries, type HostSessionSlices } from './workspace-session-host-split'
import type { SessionRelevantField } from './workspace-session'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { AcknowledgedDesktopRelays, type HeldRelayTabs } from './desktop-relay-acknowledged-hosts'
import type { CarriedRelayStatus } from './workspace-session-host-entries-write'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'

export type DesktopRelayApi = {
  desktopRelaysVersion?: () => Promise<number>
  applyDesktopRelays?: (args: DesktopRelayWrite) => Promise<DesktopRelayWriteResult>
}

type RelayHostState = {
  repos: readonly { id: string; connectionId?: string | null; executionHostId?: string | null }[]
  hydratedRuntimeSessionHostIds?: readonly ExecutionHostId[]
  contestedHostWorkspaceSessions?: HostSessionSlices
}

let probedApi: DesktopRelayApi | null = null
let probe: Promise<boolean> = Promise.resolve(false)
let settled: boolean | null = null
const acknowledgedRelays = new AcknowledgedDesktopRelays()
// Partitions this window couldn't read at startup: it holds none of their rows or relay ids.
const unreadHostIds = new Set<ExecutionHostId>()

/** A partition read that failed: the window never speaks for that host's relay ids in full. */
export function noteUnreadSessionHost(hostId: ExecutionHostId): void {
  unreadHostIds.add(hostId)
}

/** Ask main once whether it applies relay ids by ownership. An older main (no handler), the paired web
 *  client (no method) and main-owned layout answer no, and keep relay ids in ordinary saves. */
export function probeDesktopRelays(api: DesktopRelayApi): Promise<boolean> {
  if (probedApi === api) {
    return probe
  }
  probedApi = api
  acknowledgedRelays.forget()
  // Main-owned layout recomputes relay ids from live terminals on each save that carries them.
  const askVersion =
    api.applyDesktopRelays && !ORCA_LAYOUT_OWNER_IS_MAIN ? api.desktopRelaysVersion : undefined
  settled = askVersion ? null : false
  probe = askVersion
    ? askVersion().then(
        (version) => version === DESKTOP_RELAY_WRITE_VERSION,
        () => false
      )
    : Promise.resolve(false)
  void probe.then((supported) => {
    if (probedApi === api) {
      settled = supported
    }
  })
  return probe
}

/** The probe's answer, or null while it is pending (a save carrying relay ids then waits for it). */
export function desktopRelaysSupported(api: DesktopRelayApi): boolean | null {
  return probedApi === api ? settled : false
}

/** Relay ids go one way or the other only once main has said which it supports: a save carrying them
 *  while the probe is pending runs again after it. */
export function afterDesktopRelayProbe<
  T extends { localWrite: Promise<void>; written: Promise<unknown> }
>(
  api: DesktopRelayApi,
  patch: WorkspaceSessionPatch,
  retry: () => T
): { localWrite: Promise<void>; written: T['written'] } | null {
  if (!Object.hasOwn(patch, 'remoteSessionIdsByTabId') || desktopRelaysSupported(api) !== null) {
    return null
  }
  const once = probeDesktopRelays(api).then(retry)
  return { localWrite: once.then((r) => r.localWrite), written: once.then((r) => r.written) }
}

/** Hosts whose relay ids this window speaks for in full: local, its SSH repos' partitions, and runtime
 *  partitions it loaded. A partition holding rows parked for another host is never complete. */
function completeRelayHostIds(state: RelayHostState): Set<ExecutionHostId> {
  const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
  for (const repo of state.repos) {
    const hostId = getRepoExecutionHostId(repo)
    // A runtime repo can keep a nested SSH connection; only its hydration makes it complete.
    if (parseExecutionHostId(hostId)?.kind === 'ssh') {
      hostIds.add(workspaceSessionPartitionHostId(hostId))
    }
  }
  const catalogHostIds = new Set(state.repos.map((repo) => getRepoExecutionHostId(repo)))
  for (const hostId of state.hydratedRuntimeSessionHostIds ?? []) {
    if (catalogHostIds.has(hostId)) {
      hostIds.add(hostId)
    }
  }
  for (const hostId of hostIds) {
    if (state.contestedHostWorkspaceSessions?.[hostId] || unreadHostIds.has(hostId)) {
      hostIds.delete(hostId)
    }
  }
  return hostIds
}

// Per write: the tabs whose rows the window holds parked for each host (window-side only, never sent).
const heldTabsByWrite = new WeakMap<DesktopRelayWrite, HeldRelayTabs>()

function parkedTabIds(state: RelayHostState): HeldRelayTabs {
  const byHost = new Map<ExecutionHostId, Set<string>>()
  return (hostId) => {
    let tabIds = byHost.get(hostId)
    if (!tabIds) {
      tabIds = new Set()
      for (const tabs of Object.values(
        state.contestedHostWorkspaceSessions?.[hostId]?.tabsByWorktree ?? {}
      )) {
        for (const tab of tabs) {
          tabIds.add(tab.id)
        }
      }
      byHost.set(hostId, tabIds)
    }
    return tabIds
  }
}

/** Move the relay ids out of a split write into one write main applies by ownership. A host with no
 *  slice still goes when complete, so the last relay that ended there is removed. */
export function takeDesktopRelayWrite(
  slices: HostSessionSlices,
  state: RelayHostState
): DesktopRelayWrite {
  const complete = completeRelayHostIds(state)
  const hosts: DesktopRelayWrite['hosts'] = []
  const sliceHostIds = new Set<ExecutionHostId>()
  const local = slices[LOCAL_EXECUTION_HOST_ID]
  for (const [hostId, slice] of [
    ...(local ? [[LOCAL_EXECUTION_HOST_ID, local] as const] : []),
    ...nonLocalHostSessionEntries(slices)
  ]) {
    sliceHostIds.add(hostId)
    const relayIdsByTabId = slice.remoteSessionIdsByTabId ?? {}
    delete slice.remoteSessionIdsByTabId
    // Every written host goes, empty or not: an id the window wrote there may have ended.
    hosts.push({ hostId, relayIdsByTabId, complete: complete.has(hostId) })
  }
  for (const hostId of complete) {
    if (!sliceHostIds.has(hostId)) {
      hosts.push({ hostId, relayIdsByTabId: {}, complete: true })
    }
  }
  const write: DesktopRelayWrite = { version: DESKTOP_RELAY_WRITE_VERSION, hosts }
  heldTabsByWrite.set(write, parkedTabIds(state))
  return write
}

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

/** For a save that carries relay ids, when main applies them by ownership: take them out of it. */
export function desktopRelayWriteFor(
  api: DesktopRelayApi,
  patch: WorkspaceSessionPatch,
  slices: HostSessionSlices,
  state: RelayHostState
): DesktopRelayWrite | null {
  return Object.hasOwn(patch, 'remoteSessionIdsByTabId') && desktopRelaysSupported(api) === true
    ? takeDesktopRelayWrite(slices, state)
    : null
}

/** Send what changed since main last accepted this window's relay ids; null when nothing did. */
export function sendDesktopRelayWrite(
  api: DesktopRelayApi,
  full: DesktopRelayWrite
): Promise<DesktopRelayWriteResult> | null {
  if (!api.applyDesktopRelays) {
    return null
  }
  const { write, acknowledge } = acknowledgedRelays.narrow(full, heldTabsByWrite.get(full))
  if (write.hosts.length === 0) {
    return null
  }
  return api.applyDesktopRelays(write).then(
    (result) => {
      acknowledge(result)
      return result
    },
    (error: unknown) => {
      acknowledgedRelays.forget()
      throw error
    }
  )
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

export function planDesktopRelayWrite(
  api: DesktopRelayApi,
  full: DesktopRelayWrite,
  // The save's slices when its partition writes can carry relay ids (entries writes); else null.
  entrySlices: HostSessionSlices | null
): DesktopRelayPlan | null {
  const { write, acknowledge } = acknowledgedRelays.narrow(full, heldTabsByWrite.get(full))
  if (write.hosts.length === 0 || !api.applyDesktopRelays) {
    return null
  }
  const applyDesktopRelays = api.applyDesktopRelays
  // Local is always written; other hosts only when the save has their slice.
  const carriable = new Set<ExecutionHostId>(
    entrySlices
      ? [
          LOCAL_EXECUTION_HOST_ID,
          ...nonLocalHostSessionEntries(entrySlices).map(([hostId]) => hostId)
        ]
      : []
  )
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
    forget: () => acknowledgedRelays.forget()
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

function isCarriedRelayStatus(value: unknown): value is CarriedRelayStatus {
  return typeof value === 'object' && value !== null && 'relays' in value && 'hostId' in value
}

function isDesktopRelayWriteResult(value: unknown): value is DesktopRelayWriteResult {
  return typeof value === 'object' && value !== null && 'applied' in value && 'refused' in value
}

/** A remounted save subscriber starts over: what main last accepted is unknown, and a late answer to
 *  the previous subscriber's write is ignored. */
export function forgetAcknowledgedDesktopRelays(): void {
  acknowledgedRelays.forget()
}

/** A full replacement (quit, unload) may not keep what main last accepted, so it sends every host's
 *  relay ids as a baseline. */
export function replaceDesktopRelays(
  slices: HostSessionSlices,
  state: RelayHostState
): DesktopRelayWrite {
  const write = takeDesktopRelayWrite(slices, state)
  // An incomplete host's omission removes nothing, so ids the window wrote there that ended are named.
  const held = heldTabsByWrite.get(write)
  write.hosts = write.hosts.map((host) => {
    const ended = held ? acknowledgedRelays.endedOnIncompleteHost(host, held) : []
    return ended.length > 0 ? { ...host, removedTabIds: ended } : host
  })
  acknowledgedRelays.forget()
  return write
}
