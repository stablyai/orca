import { useAppStore } from '@/store'
import type { SshConnectionState, SshTarget } from '../../../shared/ssh-types'
import { callRuntimeRpc } from './runtime-rpc-client'

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

async function fetchEnvironmentSshTargets(environmentId: string): Promise<SshTarget[]> {
  const { targets } = await callRuntimeRpc<{ targets: SshTarget[] }>(
    environmentTarget(environmentId),
    'ssh.listTargets',
    undefined,
    { timeoutMs: SSH_RPC_TIMEOUT_MS }
  )
  return targets
}

/** Applies the environment's target list, then best-effort removal tombstones.
 * Targets land first — a removed-labels failure must not discard them
 * (they alone are enough evidence for the ghost-host derivation). */
async function syncEnvironmentSshTargetMetadata(environmentId: string): Promise<SshTarget[]> {
  const targets = await fetchEnvironmentSshTargets(environmentId)
  useAppStore.getState().setEnvironmentSshTargetsMetadata(environmentId, targets)
  try {
    const { labels } = await callRuntimeRpc<{ labels: Record<string, string> }>(
      environmentTarget(environmentId),
      'ssh.listRemovedTargetLabels',
      undefined,
      { timeoutMs: SSH_RPC_TIMEOUT_MS }
    )
    useAppStore.getState().setEnvironmentRemovedSshTargetLabels(environmentId, labels)
  } catch {
    // Best-effort — a missing map just falls back to the raw target id.
  }
  return targets
}

async function fetchEnvironmentSshConnectionStates(
  environmentId: string,
  targets: readonly SshTarget[]
): Promise<void> {
  for (const target of targets) {
    try {
      const { state } = await callRuntimeRpc<{ state: SshConnectionState | null }>(
        environmentTarget(environmentId),
        'ssh.getState',
        { targetId: target.id },
        { timeoutMs: SSH_RPC_TIMEOUT_MS }
      )
      if (state) {
        useAppStore.getState().setEnvironmentSshConnectionState(environmentId, target.id, state)
      }
    } catch {
      // A missing state just reads as 'disconnected'; the overlay's Connect
      // action and push events converge it.
    }
  }
}

type HydrationEntry = { promise: Promise<void>; rerunRequested: boolean }
const hydrationsInFlight = new Map<string, HydrationEntry>()

async function runEnvironmentSshHydration(environmentId: string): Promise<void> {
  const targets = await syncEnvironmentSshTargetMetadata(environmentId)
  await fetchEnvironmentSshConnectionStates(environmentId, targets)
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
  const inFlight = hydrationsInFlight.get(environmentId)
  if (inFlight) {
    if (options.force) {
      inFlight.rerunRequested = true
    }
    return inFlight.promise
  }
  const bucket = useAppStore.getState().sshStateByEnvironment.get(environmentId)
  if (!options.force && bucket?.targetsHydrated) {
    return
  }
  const entry: HydrationEntry = { promise: Promise.resolve(), rerunRequested: false }
  entry.promise = (async () => {
    try {
      await runEnvironmentSshHydration(environmentId)
      while (entry.rerunRequested) {
        entry.rerunRequested = false
        await runEnvironmentSshHydration(environmentId)
      }
    } finally {
      hydrationsInFlight.delete(environmentId)
    }
  })()
  hydrationsInFlight.set(environmentId, entry)
  return entry.promise
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
  state: SshConnectionState
): void {
  const store = useAppStore.getState()
  const bucket = store.sshStateByEnvironment.get(environmentId)
  if (bucket?.targetsHydrated && bucket.targetLabels.has(targetId)) {
    store.setEnvironmentSshConnectionState(environmentId, targetId, state)
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
  const { state } = await callRuntimeRpc<{ state: SshConnectionState | null }>(
    environmentTarget(environmentId),
    'ssh.connect',
    { targetId },
    { timeoutMs: 60_000 }
  )
  if (state) {
    useAppStore.getState().setEnvironmentSshConnectionState(environmentId, targetId, state)
  }
  return state
}

/** Resyncs the environment's target metadata after a failed connect so a
 * stale overlay converges to the ghost/re-adopted state (STA-1468). */
export async function resyncRuntimeEnvironmentSshTargets(environmentId: string): Promise<void> {
  await syncEnvironmentSshTargetMetadata(environmentId)
}
