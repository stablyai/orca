import type { RemoteServerUpdateEntry } from '../../../../../shared/remote-runtime/host-updates/remote-server-update-coordinator'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'

/**
 * Orders writes to each server's update entry. Every write takes the next number for its server;
 * a check publishes only if no write for that server happened since it began, so a response that
 * sampled the host before an update (or before a removal and re-add) cannot replace newer state.
 */
export function createRemoteServerUpdateWriteOrder() {
  const latest = new Map<string, number>()
  return {
    /** Claims the next write for this server; earlier claims can no longer publish. */
    claim(environmentId: string): number {
      const next = (latest.get(environmentId) ?? 0) + 1
      latest.set(environmentId, next)
      return next
    },
    isLatest(environmentId: string, claim: number): boolean {
      return latest.get(environmentId) === claim
    }
  }
}

const UPDATE_RUNNING_PHASES: ReadonlySet<RemoteServerUpdateEntry['phase']> = new Set([
  'queued',
  'checking-update',
  'downloading',
  'restarting'
])

/** The verified runtime a host answers as now; null while unreachable, revoked or unverified. */
function verifiedRuntimeId(entry: RuntimeEnvironmentStatus | undefined): string | null {
  return entry?.status?.runtimeId ?? null
}

/**
 * Servers whose update entry this status publication makes stale: the host now answers, verified,
 * as a runtime the entry did not see. A running update owns its entry and is left alone. Only a
 * change in this publication counts, so an unchanged host is never re-checked twice.
 */
export function remoteServersToRecheck(
  entries: ReadonlyMap<string, RemoteServerUpdateEntry>,
  statuses: ReadonlyMap<string, RuntimeEnvironmentStatus>,
  previousStatuses: ReadonlyMap<string, RuntimeEnvironmentStatus>
): string[] {
  const stale: string[] = []
  for (const entry of entries.values()) {
    const runtimeId = verifiedRuntimeId(statuses.get(entry.environmentId))
    if (
      runtimeId !== null &&
      runtimeId !== verifiedRuntimeId(previousStatuses.get(entry.environmentId)) &&
      runtimeId !== entry.runtimeId &&
      !UPDATE_RUNNING_PHASES.has(entry.phase)
    ) {
      stale.push(entry.environmentId)
    }
  }
  return stale
}
