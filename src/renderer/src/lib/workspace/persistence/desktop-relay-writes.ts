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
import { AcknowledgedDesktopRelays } from './desktop-relay-acknowledged-hosts'

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

/** Ask main once whether it applies relay ids by ownership. An older main (no handler) and the paired
 *  web client (no method) answer no, and keep relay ids in ordinary saves. */
export function probeDesktopRelays(api: DesktopRelayApi): Promise<boolean> {
  if (probedApi === api) {
    return probe
  }
  probedApi = api
  acknowledgedRelays.forget()
  const askVersion = api.applyDesktopRelays ? api.desktopRelaysVersion : undefined
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
    if (state.contestedHostWorkspaceSessions?.[hostId]) {
      hostIds.delete(hostId)
    }
  }
  return hostIds
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
    if (complete.has(hostId) || Object.keys(relayIdsByTabId).length > 0) {
      hosts.push({ hostId, relayIdsByTabId, complete: complete.has(hostId) })
    }
  }
  for (const hostId of complete) {
    if (!sliceHostIds.has(hostId)) {
      hosts.push({ hostId, relayIdsByTabId: {}, complete: true })
    }
  }
  return { version: DESKTOP_RELAY_WRITE_VERSION, hosts }
}

/** A write main accepted but could not fully apply (a fenced partition, a refused id): resend these fields later. */
export type SessionWriteOutcome = { pendingFields?: readonly SessionRelevantField[] }

export function relayWriteOutcome(
  result: DesktopRelayWriteResult | null | undefined
): SessionWriteOutcome | void {
  // A ptyIdsByTabId change rebuilds every host's relay ids on the next save; refused hosts retry then.
  return result?.skipped.length || result?.refused.length
    ? { pendingFields: ['ptyIdsByTabId'] }
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
  const { write, acknowledge } = acknowledgedRelays.narrow(full)
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

/** A full replacement (quit, unload) may not keep what main last accepted, so it sends every host's
 *  relay ids as a baseline. */
export function replaceDesktopRelays(
  slices: HostSessionSlices,
  state: RelayHostState
): DesktopRelayWrite {
  acknowledgedRelays.forget()
  return takeDesktopRelayWrite(slices, state)
}
