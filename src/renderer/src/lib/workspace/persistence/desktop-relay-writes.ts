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
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'
import {
  AcknowledgedDesktopRelays,
  type HeldRelayTabs,
  type RelayWriteContext
} from './desktop-relay-acknowledged-hosts'
import { routedSessionHostIds } from './workspace-session-host-entries-write'
import type { HostPersistenceState } from './workspace-session-host-persistence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'

export type DesktopRelayApi = {
  desktopRelaysVersion?: () => Promise<number>
  applyDesktopRelays?: (args: DesktopRelayWrite) => Promise<DesktopRelayWriteResult>
}

type RelayHostState = Pick<
  HostPersistenceState,
  | 'repos'
  | 'hydratedRuntimeSessionHostIds'
  | 'contestedHostWorkspaceSessions'
  | 'folderWorkspaces'
  | 'projectGroups'
>

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

// Per write: what the window knew when it built it (window-side only, never sent).
const contextByWrite = new WeakMap<DesktopRelayWrite, RelayWriteContext>()

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

/** Hosts with a live owner: catalog repos, folders and groups, parked rows, or an unread partition.
 *  Startup lists (hydrated, restored and contested hosts) outlive removals, so they don't count.
 *  Built only when a host the window last wrote is missing from a write. */
function routedRelayHosts(state: RelayHostState): RelayWriteContext['routes'] {
  let routed: Set<ExecutionHostId> | null = null
  return (hostId) => {
    const { repos, folderWorkspaces, projectGroups } = state
    routed ??= new Set([
      ...routedSessionHostIds({ repos, folderWorkspaces, projectGroups }, {}),
      ...nonLocalHostSessionEntries(state.contestedHostWorkspaceSessions ?? {}).map(([id]) => id),
      ...unreadHostIds
    ])
    return routed.has(hostId)
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
  contextByWrite.set(write, { held: parkedTabIds(state), routes: routedRelayHosts(state) })
  return write
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

/** Narrow a full write to what main hasn't accepted; `acknowledge` records main's answer. */
export function narrowDesktopRelayWrite(full: DesktopRelayWrite) {
  return acknowledgedRelays.narrow(full, contextByWrite.get(full))
}

/** A remounted save subscriber starts over: every host resends a baseline, and a late answer to the
 *  previous subscriber's write is ignored. */
export function forgetAcknowledgedDesktopRelays(): void {
  acknowledgedRelays.invalidate()
}

/** A full replacement (quit, unload) may not keep what main last accepted, so it sends every host's
 *  relay ids as a baseline. */
export function replaceDesktopRelays(
  slices: HostSessionSlices,
  state: RelayHostState
): DesktopRelayWrite {
  // Unanswered writes count as evidence too: main may store them before this replacement.
  acknowledgedRelays.invalidate()
  const write = takeDesktopRelayWrite(slices, state)
  // An incomplete host's omission removes nothing, so ids the window wrote there that ended are named.
  const held = contextByWrite.get(write)?.held
  write.hosts = write.hosts.map((host) => {
    const ended = held ? acknowledgedRelays.endedOnIncompleteHost(host, held) : []
    return ended.length > 0 ? { ...host, removedTabIds: ended } : host
  })
  acknowledgedRelays.replacedBy(write)
  return write
}
