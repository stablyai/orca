// Retry host-deferred sleeping restores without waiting for reveal. Serialize asks per host under its admission gate; continued deferral backs off to minutes.
import type { AutomaticWorkStatus } from '../../../shared/host-spawn-admission'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

const FIRST_RETRY_MS = 30_000
const MAX_RETRY_MS = 5 * 60_000
// Why short: an admitted restore means the host has room, and its gate paces the next one itself.
const AFTER_START_MS = 1_000
const PROBE_TIMEOUT_MS = 10_000

/** Resolves true when the pane got a PTY; a pane deferred again queues itself anew. */
type Retry = () => Promise<boolean>
type Waiting = { environmentId: string | null; retry: Retry }
type HostDrain = { timer: ReturnType<typeof setTimeout> | null; delayMs: number; running: boolean }

const waiting = new Map<string, Waiting>()
const hosts = new Map<string, HostDrain>()

function hostKey(environmentId: string | null): string {
  return environmentId ?? ''
}

export function queueDeferredRestoreRetry(
  paneKey: string,
  environmentId: string | null,
  retry: Retry
): void {
  // Reinsert deferred panes at the back so all sleepers get a turn.
  waiting.delete(paneKey)
  waiting.set(paneKey, { environmentId, retry })
  schedule(environmentId)
}

export function cancelDeferredRestoreRetry(paneKey: string): void {
  waiting.delete(paneKey)
}

function nextWaiting(environmentId: string | null): [string, Waiting] | undefined {
  for (const entry of waiting) {
    if (hostKey(entry[1].environmentId) === hostKey(environmentId)) {
      return entry
    }
  }
  return undefined
}

function schedule(environmentId: string | null): void {
  const key = hostKey(environmentId)
  let drain = hosts.get(key)
  if (!drain) {
    drain = { timer: null, delayMs: FIRST_RETRY_MS, running: false }
    hosts.set(key, drain)
  }
  if (drain.timer !== null || drain.running) {
    return
  }
  const scheduled = drain
  scheduled.timer = setTimeout(() => void run(environmentId, scheduled), scheduled.delayMs)
}

/** Asking only a reachable, unpaused host keeps a sleeping pane from turning into a failed spawn. */
async function hostAcceptsAutomaticRestores(environmentId: string | null): Promise<boolean> {
  try {
    const status = await callRuntimeRpc<{ automaticWork: AutomaticWorkStatus | null }>(
      runtimeTargetForOwnerEnvironment(environmentId),
      'runtime.automaticWork.status',
      undefined,
      { timeoutMs: PROBE_TIMEOUT_MS }
    )
    return status.automaticWork?.mode.kind !== 'paused'
  } catch {
    return false
  }
}

async function run(environmentId: string | null, drain: HostDrain): Promise<void> {
  drain.timer = null
  drain.running = true
  let started = false
  try {
    if (nextWaiting(environmentId) && (await hostAcceptsAutomaticRestores(environmentId))) {
      const next = nextWaiting(environmentId)
      if (next) {
        waiting.delete(next[0])
        started = await next[1].retry()
      }
    }
  } catch {
    started = false
  }
  drain.running = false
  drain.delayMs = started
    ? AFTER_START_MS
    : Math.min(Math.max(drain.delayMs * 2, FIRST_RETRY_MS), MAX_RETRY_MS)
  if (nextWaiting(environmentId)) {
    schedule(environmentId)
  } else if (hosts.get(hostKey(environmentId)) === drain) {
    hosts.delete(hostKey(environmentId))
  }
}

export function resetDeferredRestoreDrainForTests(): void {
  for (const drain of hosts.values()) {
    if (drain.timer !== null) {
      clearTimeout(drain.timer)
    }
  }
  hosts.clear()
  waiting.clear()
}
