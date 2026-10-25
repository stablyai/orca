import { useAppStore } from '@/store'
import type { SshConnectionState, SshTargetSummary } from '../../../shared/ssh-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { admitSshConnectionState } from '../../../shared/ssh-retained-payload-admission'
import {
  collectSshTargetGenerations,
  sshTargetGenerationsEqual,
  sshTargetLabelsEqual
} from '@/store/slices/ssh-target-cleanup'
import { sanitizeSshTargetGeneration } from '../../../shared/ssh-target-generation'
import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'

/** Mirror server-owned SSH state into only its per-environment bucket so paired desktops get reconnect overlays (STA-1468); local SSH maps remain independent. */

const SSH_RPC_TIMEOUT_MS = 15_000
// Decorative reads share the host’s 8-slot foreground lane; bound concurrency to cut N×15s stalls without starving interactions.
export const SSH_STATE_READ_CONCURRENCY = 3

function environmentTarget(environmentId: string): { kind: 'environment'; environmentId: string } {
  return { kind: 'environment', environmentId }
}

async function fetchEnvironmentSshTargets(environmentId: string): Promise<SshTargetSummary[]> {
  const { targets } = await callRuntimeRpc<{ targets: SshTargetSummary[] }>(
    environmentTarget(environmentId),
    'ssh.listTargetSummaries',
    undefined,
    { timeoutMs: SSH_RPC_TIMEOUT_MS }
  )
  if (!Array.isArray(targets)) {
    throw new Error('Remote SSH target metadata is invalid')
  }
  return targets.map((target) => {
    if (typeof target.id !== 'string' || typeof target.label !== 'string') {
      throw new Error('Remote SSH target metadata is invalid')
    }
    // Why: an old server omits `generation`; a malformed one is dropped rather than trusted as a fence value.
    const generation = sanitizeSshTargetGeneration(target.generation)
    return {
      id: target.id,
      label: target.label,
      ...(generation === undefined ? {} : { generation })
    }
  })
}

/** Applies the environment's target list, then best-effort removal tombstones.
 * Targets land first — a removed-labels failure must not discard them
 * (they alone are enough evidence for the ghost-host derivation). */
async function syncEnvironmentSshTargetMetadata(
  environmentId: string,
  generation: number
): Promise<SshTargetSummary[]> {
  const targets = await fetchEnvironmentSshTargets(environmentId)
  if (generation !== getEnvironmentSshStateGeneration(environmentId)) {
    return []
  }
  useAppStore.getState().setEnvironmentSshTargetsMetadata(environmentId, targets, generation)
  await syncEnvironmentRemovedSshTargetLabels(environmentId, generation)
  return generation === getEnvironmentSshStateGeneration(environmentId) ? targets : []
}

async function syncEnvironmentRemovedSshTargetLabels(
  environmentId: string,
  generation: number
): Promise<void> {
  try {
    const { labels } = await callRuntimeRpc<{ labels: Record<string, string> }>(
      environmentTarget(environmentId),
      'ssh.listRemovedTargetLabels',
      undefined,
      { timeoutMs: SSH_RPC_TIMEOUT_MS }
    )
    useAppStore.getState().setEnvironmentRemovedSshTargetLabels(environmentId, labels, generation)
  } catch {
    // Best-effort — a missing map just falls back to the raw target id.
  }
}

async function fetchEnvironmentSshConnectionStates(
  environmentId: string,
  targets: readonly SshTargetSummary[],
  generation: number
): Promise<void> {
  await forEachWithConcurrency(targets, SSH_STATE_READ_CONCURRENCY, async (target) => {
    if (generation !== getEnvironmentSshStateGeneration(environmentId)) {
      return
    }
    try {
      const { state } = await callRuntimeRpc<{ state: SshConnectionState | null }>(
        environmentTarget(environmentId),
        'ssh.getState',
        { targetId: target.id },
        { timeoutMs: SSH_RPC_TIMEOUT_MS }
      )
      const admittedState = state ? admitSshConnectionState(state, target.id) : null
      if (admittedState) {
        useAppStore
          .getState()
          .setEnvironmentSshConnectionState(environmentId, target.id, admittedState, generation)
      }
    } catch {
      // Why: a timeout or unsupported RPC is not authoritative evidence that the HUB's SSH link disconnected.
    }
  })
}

type SshRefreshKind = 'metadata' | 'full'
type SshRefreshEntry = {
  promise: Promise<void>
  generation: number
  kind: SshRefreshKind
  rerunKind: SshRefreshKind | null
}
const sshRefreshesInFlight = new Map<string, SshRefreshEntry>()

function mergeSshRefreshKind(
  current: SshRefreshKind | null,
  requested: SshRefreshKind
): SshRefreshKind {
  return current === 'full' || requested === 'full' ? 'full' : 'metadata'
}

async function runEnvironmentSshHydration(environmentId: string): Promise<void> {
  const generation = getEnvironmentSshStateGeneration(environmentId)
  const targets = await syncEnvironmentSshTargetMetadata(environmentId, generation)
  await fetchEnvironmentSshConnectionStates(environmentId, targets, generation)
}

async function runEnvironmentSshTargetMetadataRefresh(environmentId: string): Promise<void> {
  const generation = getEnvironmentSshStateGeneration(environmentId)
  const bucket = useAppStore.getState().sshStateByEnvironment.get(environmentId)
  const targets = await fetchEnvironmentSshTargets(environmentId)
  if (generation !== getEnvironmentSshStateGeneration(environmentId)) {
    return
  }
  const priorTargetGenerations = bucket?.targetGenerations ?? new Map<string, number>()
  const nextTargetGenerations = collectSshTargetGenerations(targets)
  const metadataChanged =
    !bucket?.targetsHydrated ||
    !sshTargetLabelsEqual(bucket.targetLabels, targets) ||
    !sshTargetGenerationsEqual(priorTargetGenerations, nextTargetGenerations)
  useAppStore.getState().setEnvironmentSshTargetsMetadata(environmentId, targets, generation)
  const priorTargetIds = new Set(bucket?.targetLabels.keys() ?? [])
  // Why: read states after the write — a resync racing this fetch can label a target that never had one read.
  const knownStates = useAppStore
    .getState()
    .sshStateByEnvironment.get(environmentId)?.connectionStates
  const needStateRead = targets.filter(
    (target) =>
      !priorTargetIds.has(target.id) ||
      !knownStates?.has(target.id) ||
      priorTargetGenerations.get(target.id) !== nextTargetGenerations.get(target.id)
  )
  if (!metadataChanged) {
    await fetchEnvironmentSshConnectionStates(environmentId, needStateRead, generation)
    return
  }
  await syncEnvironmentRemovedSshTargetLabels(environmentId, generation)
  await fetchEnvironmentSshConnectionStates(environmentId, needStateRead, generation)
}

function requestSshRefreshRerun(entry: SshRefreshEntry, kind: SshRefreshKind): void {
  entry.rerunKind = mergeSshRefreshKind(entry.rerunKind, kind)
}

function startEnvironmentSshRefresh(
  environmentId: string,
  initialKind: SshRefreshKind
): Promise<void> {
  const entry: SshRefreshEntry = {
    promise: Promise.resolve(),
    generation: getEnvironmentSshStateGeneration(environmentId),
    kind: initialKind,
    rerunKind: null
  }
  entry.promise = (async () => {
    let nextKind: SshRefreshKind | null = initialKind
    let lastError: unknown = null
    try {
      while (nextKind) {
        entry.kind = nextKind
        entry.generation = getEnvironmentSshStateGeneration(environmentId)
        entry.rerunKind = null
        try {
          await (entry.kind === 'full'
            ? runEnvironmentSshHydration(environmentId)
            : runEnvironmentSshTargetMetadataRefresh(environmentId))
          lastError = null
        } catch (error) {
          lastError = error
          if (entry.rerunKind) {
            entry.rerunKind = mergeSshRefreshKind(entry.rerunKind, entry.kind)
          }
        }
        nextKind = entry.rerunKind
      }
      if (lastError) {
        throw lastError
      }
    } finally {
      if (sshRefreshesInFlight.get(environmentId) === entry) {
        sshRefreshesInFlight.delete(environmentId)
      }
    }
  })()
  sshRefreshesInFlight.set(environmentId, entry)
  return entry.promise
}

/** Single-flight hydrate targets/tombstones/states. force during flight queues one follow-up so newly added targets cannot be lost behind stale fetches. Unsupported hosts stay unhydrated/unknown, never destructive. */
export async function hydrateRuntimeEnvironmentSshState(
  environmentId: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const generation = getEnvironmentSshStateGeneration(environmentId)
  const inFlight = sshRefreshesInFlight.get(environmentId)
  if (inFlight) {
    if (options.force || inFlight.generation !== generation) {
      requestSshRefreshRerun(inFlight, 'full')
    }
    return inFlight.promise
  }
  const bucket = useAppStore.getState().sshStateByEnvironment.get(environmentId)
  if (!options.force && bucket?.targetsHydrated) {
    return
  }
  return startEnvironmentSshRefresh(environmentId, 'full')
}

/** Refreshes target membership without re-reading every known target state. */
export async function refreshRuntimeEnvironmentSshTargetMetadata(
  environmentId: string
): Promise<void> {
  const generation = getEnvironmentSshStateGeneration(environmentId)
  const inFlight = sshRefreshesInFlight.get(environmentId)
  if (inFlight) {
    requestSshRefreshRerun(inFlight, inFlight.generation === generation ? 'metadata' : 'full')
    return inFlight.promise
  }
  const bucket = useAppStore.getState().sshStateByEnvironment.get(environmentId)
  return startEnvironmentSshRefresh(environmentId, bucket?.targetsHydrated ? 'metadata' : 'full')
}

/** Known-target events update that environment only. Unknown targets force authoritative membership/state hydration, preventing trailing removed-target events from resurrecting them. */
export function applyRuntimeEnvironmentSshStateChanged(
  environmentId: string,
  targetId: string,
  state: SshConnectionState,
  generation = getEnvironmentSshStateGeneration(environmentId)
): void {
  if (generation !== getEnvironmentSshStateGeneration(environmentId)) {
    return
  }
  const admittedState = admitSshConnectionState(state, targetId)
  if (!admittedState) {
    return
  }
  const store = useAppStore.getState()
  const bucket = store.sshStateByEnvironment.get(environmentId)
  if (bucket?.targetsHydrated && bucket.targetLabels.has(targetId)) {
    store.setEnvironmentSshConnectionState(environmentId, targetId, admittedState, generation)
    return
  }
  void hydrateRuntimeEnvironmentSshState(environmentId, { force: true }).catch(() => {})
}

/** Connects the environment's own SSH target via its runtime RPC and mirrors
 * the returned state into the bucket (ssh.connect can resolve before the
 * push event lands). */
export async function connectRuntimeEnvironmentSshTarget(
  environmentId: string,
  targetId: string
): Promise<SshConnectionState | null> {
  const generation = getEnvironmentSshStateGeneration(environmentId)
  const { state } = await callRuntimeRpc<{ state: SshConnectionState | null }>(
    environmentTarget(environmentId),
    'ssh.connect',
    { targetId },
    { timeoutMs: 60_000 }
  )
  const admittedState = state ? admitSshConnectionState(state, targetId) : null
  if (admittedState) {
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState(environmentId, targetId, admittedState, generation)
  }
  return admittedState
}

/** After failed connect, fully hydrate metadata AND state so ghost/re-adopted hosts converge; metadata alone leaves new target IDs’ chips/mutation gates dead (STA-1468). */
export async function resyncRuntimeEnvironmentSshTargets(environmentId: string): Promise<void> {
  await hydrateRuntimeEnvironmentSshState(environmentId, { force: true })
}
