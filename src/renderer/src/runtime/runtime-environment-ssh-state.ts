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

/**
 * Mirrors a remote Orca server's own SSH targets into that environment's
 * per-environment SSH bucket (store slice `runtime-environment-ssh`), so a
 * desktop client attached to the server gets live reconnect overlays for the
 * server's SSH-backed workspaces (STA-1468, desktop topology). Never touches
 * the local SSH maps.
 */

const SSH_RPC_TIMEOUT_MS = 15_000

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
  for (const target of targets) {
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
  }
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

/**
 * Fetches the environment's SSH targets, removal tombstones, and per-target
 * connection states into its bucket. Single-flight per environment; a `force`
 * request during an in-flight run schedules exactly one follow-up run so a
 * refresh triggered by a just-added target can't be swallowed by a stale
 * in-flight fetch.
 *
 * Hosts without the ssh.* RPC methods fail here and leave the bucket
 * un-hydrated — reads then resolve to "unknown", never to destructive UI.
 */
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

/**
 * Applies a `sshStateChanged` runtime client event from `environmentId` to
 * that environment's bucket. For a target the bucket doesn't know yet
 * (added after hydration, or a disconnect racing a removal), the authoritative
 * target list is re-fetched instead of trusting the event: the forced
 * hydration also re-reads the state, so a removed target's trailing event
 * can't resurrect it.
 */
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

/** Resyncs the environment's target metadata after a failed connect so a
 * stale overlay converges to the ghost/re-adopted state (STA-1468). Full
 * hydration, not metadata alone: a host re-added under a new target id must
 * land with a connection state or its chip and mutation gate stay dead. */
export async function resyncRuntimeEnvironmentSshTargets(environmentId: string): Promise<void> {
  await hydrateRuntimeEnvironmentSshState(environmentId, { force: true })
}
