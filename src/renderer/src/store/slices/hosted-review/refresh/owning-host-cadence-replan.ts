import {
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

/** Rebuilds targets through `update` when the cadence of a host that runs one of them changes. A
 *  change on any other host does no work at all, however many rows are visible. */
export function followOwningHostCadence(
  update: () => readonly VisibleHostedReviewRefreshTarget[]
): { update: () => void; dispose: () => void } {
  let hosts = new Set<string | null>()
  const run = (): void => {
    hosts = new Set(update().map((target) => target.cadenceHost ?? null))
  }
  const dispose = subscribePRAutoRefreshCadence((hostKey) => {
    if (hosts.has(hostKey)) {
      run()
    }
  })
  return { update: run, dispose }
}
