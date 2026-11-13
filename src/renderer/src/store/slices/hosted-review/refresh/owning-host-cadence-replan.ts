import {
  getPRAutoRefreshCadenceForHost,
  scaleReviewRefreshInterval,
  subscribePRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../../../shared/review-refresh-policy'
import type { VisibleHostedReviewRefreshTarget } from './visible-hosted-review-refresh-scheduler'

/** Which host's cadence governs a visible target, and what that cadence is. */
export type OwningHostCadence = {
  /** The owning host's auto-refresh cadence; "off" also stops timed and receipt retries. */
  cadence?: PRAutoRefreshCadence
  /** The paired host that runs this read, null for this app; only its cadence re-plans the target. */
  cadenceHost?: string | null
}

/**
 * Keeps the targets `build` last made and hands them to `apply`. A host's cadence change re-plans
 * only that host's targets from their own Default interval; nothing is built again, so another
 * host's change costs no row work however many rows are visible. Store and visibility changes still
 * call `update` to rebuild the whole set.
 */
export function followOwningHostCadence(
  build: () => readonly VisibleHostedReviewRefreshTarget[],
  apply: (targets: readonly VisibleHostedReviewRefreshTarget[]) => void
): { update: () => void; dispose: () => void } {
  let targets: readonly VisibleHostedReviewRefreshTarget[] = []
  let hosts = new Set<string | null>()
  const update = (): void => {
    targets = build()
    hosts = new Set(targets.map((target) => target.cadenceHost ?? null))
    apply(targets)
  }
  const dispose = subscribePRAutoRefreshCadence((hostKey) => {
    if (!hosts.has(hostKey)) {
      return
    }
    const cadence = getPRAutoRefreshCadenceForHost(hostKey)
    targets = targets.map((target) =>
      (target.cadenceHost ?? null) !== hostKey || target.foregroundIntervalMs === undefined
        ? target
        : {
            ...target,
            cadence,
            intervalMs: scaleReviewRefreshInterval(target.foregroundIntervalMs, cadence)
          }
    )
    apply(targets)
  })
  return { update, dispose }
}
