/**
 * Re-probes runtime environments whose recorded status is `null`.
 *
 * `runtimeStatusByEnvironmentId` is written only by explicit probes (boot
 * hydration, the status-bar host dropdown, the settings pane, connect/disconnect).
 * Nothing feeds a transport that reconnected on its own back into it, so one
 * failed boot probe left a reachable host reading "disconnected" for the whole
 * session (#16516).
 *
 * Neither trigger here decides reachability: both re-run the real
 * `status.get` probe and let its answer stand. Loss of contact stays
 * unverifiable, never "exited" — see docs/reference/ssh-execution-boundary.md.
 */

import type { RuntimeStatusRefreshOutcome } from '@/store/slices/runtime-status-refresh'

const RECOVERY_PROBE_BASE_DELAY_MS = 5_000
const RECOVERY_PROBE_MAX_DELAY_MS = 60_000
/** Longer than the probe's own 10s timeout, so this only governs a refresh that never settles. */
const RECOVERY_PROBE_PENDING_GUARD_MS = 15_000

export type RuntimeStatusRecoveryPort = {
  /** The shared host derivation's `disconnected` verdict, so the hosts this loop retries are
   * exactly the hosts the sidebar paints red. A private predicate drifts (#16518 review). */
  isRuntimeEnvironmentDisconnected: (environmentId: string) => boolean
  listDisconnectedRuntimeEnvironmentIds: () => readonly string[]
  refreshRuntimeEnvironmentStatus: (environmentId: string) => Promise<RuntimeStatusRefreshOutcome>
  /** Reports every change to the recorded statuses. Without it a host that goes
   * unreachable after start — the boot probe included — never starts its clock. */
  subscribeToRecordedStatusChanges: (onChange: () => void) => () => void
}

let port: RuntimeStatusRecoveryPort | null = null
let timer: ReturnType<typeof setTimeout> | null = null
type RecoveryBackoff = { failures: number; nextAttemptAt: number; trafficProbedAt: number | null }
/** Per-environment retry budget. Each host backs off on its own clock, so one
 * freshly-failing host cannot drag a long-unreachable one back to the base interval. */
const backoffByEnvironment = new Map<string, RecoveryBackoff>()
const probingEnvironments = new Set<string>()
/** One generation per installed port. A stopped session clears the state below, so without
 * this its probe would settle into the next session's — see `probe` (#16518 review). */
let sessionGeneration = 0

function backoffDelayMs(failures: number): number {
  return Math.min(RECOVERY_PROBE_BASE_DELAY_MS * 2 ** failures, RECOVERY_PROBE_MAX_DELAY_MS)
}

function backoffFor(environmentId: string, now: number): RecoveryBackoff {
  let entry = backoffByEnvironment.get(environmentId)
  if (!entry) {
    // First sighting: the caller's own probe just recorded this host unreachable,
    // so wait one interval rather than re-asking the question it answered.
    entry = {
      failures: 0,
      nextAttemptAt: now + RECOVERY_PROBE_BASE_DELAY_MS,
      trafficProbedAt: null
    }
    backoffByEnvironment.set(environmentId, entry)
  }
  return entry
}

/** Why not the stored deadline while a probe is in flight: that deadline is already in the
 * past, so scheduling against it would spin, and skipping the schedule entirely would let one
 * never-settling probe strand every other host. */
function nextAttemptAtFor(environmentId: string, now: number): number {
  return probingEnvironments.has(environmentId)
    ? now + RECOVERY_PROBE_PENDING_GUARD_MS
    : backoffFor(environmentId, now).nextAttemptAt
}

/** Re-arms at the current interval without widening it. The attempt still happened, so
 * re-asking now would spin, but nothing was learned to charge against the host. */
function deferProbeWithoutPenalty(environmentId: string): void {
  const now = Date.now()
  const entry = backoffFor(environmentId, now)
  entry.nextAttemptAt = now + backoffDelayMs(entry.failures)
}

/** Widens the retry budget. Named for the recovery attempt, not the transport: a host that
 * answers `status.get` while still reading `disconnected` has not recovered either. */
function recordUnrecoveredProbe(environmentId: string): void {
  const now = Date.now()
  const entry = backoffFor(environmentId, now)
  entry.failures += 1
  entry.nextAttemptAt = now + backoffDelayMs(entry.failures)
}

function probe(environmentId: string): void {
  const active = port
  if (!active || probingEnvironments.has(environmentId)) {
    return
  }
  // Why capture: StrictMode double-mounts the effect that installs the port, so this probe
  // routinely outlives its own session. Settling into the live one would charge its retry
  // budget and clear the in-flight marker of a probe that is still running.
  const generation = sessionGeneration
  const isLiveSession = (): boolean => generation === sessionGeneration
  probingEnvironments.add(environmentId)
  void active
    .refreshRuntimeEnvironmentStatus(environmentId)
    .then((outcome) => {
      if (!isLiveSession()) {
        return
      }
      // Why: a superseded answer belongs to a retired pairing, so it is evidence about
      // neither this host's reachability nor its state — leave the budget where it was.
      if (outcome === 'superseded') {
        deferProbeWithoutPenalty(environmentId)
        return
      }
      // Why re-read the verdict instead of trusting the boolean: a reachable host can still
      // derive as disconnected (a control channel closed with an error), and re-probing that
      // one at the base interval forever is a poll loop, not a recovery loop.
      if (active.isRuntimeEnvironmentDisconnected(environmentId)) {
        recordUnrecoveredProbe(environmentId)
      } else {
        backoffByEnvironment.delete(environmentId)
      }
    })
    .catch(() => {
      if (isLiveSession()) {
        recordUnrecoveredProbe(environmentId)
      }
    })
    .finally(() => {
      if (!isLiveSession()) {
        return
      }
      probingEnvironments.delete(environmentId)
      // Rearm, not schedule: this host's new deadline can be earlier than the pending
      // guard the sweep armed against while the probe was in flight.
      rearmSweep()
    })
}

function scheduleNextSweep(): void {
  if (timer !== null || !port) {
    return
  }
  const disconnected = port.listDisconnectedRuntimeEnvironmentIds()
  if (disconnected.length === 0) {
    // Why: nothing to recover — stay idle instead of holding a forever-ticking timer.
    backoffByEnvironment.clear()
    return
  }
  const now = Date.now()
  const earliestAttemptAt = Math.min(
    ...disconnected.map((environmentId) => nextAttemptAtFor(environmentId, now))
  )
  // Recovered and removed environments must not keep a retry budget alive.
  const stillDisconnected = new Set(disconnected)
  for (const environmentId of backoffByEnvironment.keys()) {
    if (!stillDisconnected.has(environmentId)) {
      backoffByEnvironment.delete(environmentId)
    }
  }
  const nextSweep = setTimeout(
    () => {
      timer = null
      sweep()
    },
    Math.max(0, earliestAttemptAt - now)
  )
  // Why: a recovery retry must never hold a test runner or a headless process open.
  nextSweep.unref?.()
  timer = nextSweep
}

function sweep(): void {
  const active = port
  if (!active) {
    return
  }
  const now = Date.now()
  for (const environmentId of active.listDisconnectedRuntimeEnvironmentIds()) {
    if (backoffFor(environmentId, now).nextAttemptAt <= now) {
      probe(environmentId)
    }
  }
  // Unconditional: every sweep must leave a timer armed for whoever is due next, or a
  // probe that never settles ends the recovery loop for all of them.
  scheduleNextSweep()
}

function rearmSweep(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  scheduleNextSweep()
}

/**
 * Records that the renderer just exchanged traffic with this environment.
 *
 * Traffic is evidence the host is reachable, not proof of its state: consumers
 * read the whole `RuntimeStatus` (capabilities, remote control, workspace
 * window), so this only asks for a fresh probe.
 */
export function noteRuntimeEnvironmentReachable(environmentId: string): void {
  if (!port?.isRuntimeEnvironmentDisconnected(environmentId)) {
    return
  }
  const now = Date.now()
  const entry = backoffFor(environmentId, now)
  // Why traffic gets its own floor instead of deferring to `nextAttemptAt`: traffic is
  // evidence the failure deadline has not seen, so a host answering at the 60s cap must
  // recover now, not a minute later (#16516). The floor is the sweep's own base interval,
  // so traffic can never probe faster than the recovery loop already does.
  if (
    entry.trafficProbedAt !== null &&
    now - entry.trafficProbedAt < RECOVERY_PROBE_BASE_DELAY_MS
  ) {
    return
  }
  entry.trafficProbedAt = now
  // The entry survives: a host that answers requests but fails `status.get` must not
  // reset the sweep's widening backoff on every request.
  probe(environmentId)
}

export function startRuntimeStatusRecoveryProbe(next: RuntimeStatusRecoveryPort): () => void {
  port = next
  // Re-arm against the new set; each host keeps the retry budget it had earned.
  const unsubscribe = next.subscribeToRecordedStatusChanges(rearmSweep)
  scheduleNextSweep()
  return () => {
    unsubscribe()
    if (port !== next) {
      return
    }
    // Retires every in-flight probe with the port, so none of them writes the state cleared below.
    sessionGeneration += 1
    port = null
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    backoffByEnvironment.clear()
    probingEnvironments.clear()
  }
}

/** Re-probes every disconnected environment immediately, ignoring its backoff. */
export function retryRuntimeStatusRecoveryProbesNow(): void {
  const now = Date.now()
  for (const environmentId of port?.listDisconnectedRuntimeEnvironmentIds() ?? []) {
    backoffByEnvironment.set(environmentId, {
      failures: 0,
      nextAttemptAt: now,
      trafficProbedAt: null
    })
  }
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  sweep()
}
