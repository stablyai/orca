/**
 * Decides which of the requested entries actually get fetched this cycle, and
 * captures the fence each one will have to commit under.
 *
 * Everything that makes a request *not* happen lives here: a duplicate ref, a
 * still-fresh entry, one already in flight, and one inside its retry cooldown.
 * The scheduler then only has to decide how to send what survives.
 */

import { hostStableKey } from '../../../../shared/automation-owner-key'
import type { AutomationHostCache } from './automation-host-cache'
import type { AutomationHostRequestFence } from './automation-host-cache-types'
// Type-only, so it is erased before it could become an import cycle at runtime.
import type { AutomationHostFetchTarget } from './automation-host-scheduler'

export type PlannedAutomationHostTarget = AutomationHostFetchTarget & {
  stableKey: string
  fence: AutomationHostRequestFence
}

export type AutomationHostRequestPlanOptions = {
  cache: AutomationHostCache
  targets: readonly AutomationHostFetchTarget[]
  /** Skips freshness and cooldown, and supersedes anything already in flight. */
  force: boolean
  /** Manual All-host refresh: it bypasses TTL but never re-enqueues a known failure. */
  skipKnownFailures?: boolean
  now: () => number
}

export function planAutomationHostRequests({
  cache,
  targets,
  force,
  skipKnownFailures = false,
  now
}: AutomationHostRequestPlanOptions): PlannedAutomationHostTarget[] {
  const planned = new Map<string, PlannedAutomationHostTarget>()
  for (const target of targets) {
    const stableKey = hostStableKey(target.ref)
    const existing = planned.get(stableKey)
    if (existing) {
      existing.priority = existing.priority === true || target.priority === true
      continue
    }
    const entry = cache.getByKey(stableKey)
    if (force) {
      if (skipKnownFailures && entry?.error && !entry.error.retryable) {
        continue
      }
      // Why: a replacement request must outrank the one it replaces, or the older
      // answer lands last and overwrites the fresher rows it was meant to supersede.
      if (entry?.request) {
        cache.supersede(target.ref)
      }
    } else {
      if (cache.freshness(target.ref) === 'fresh' || entry?.request) {
        continue
      }
      const error = entry?.error
      if (error && (!error.retryable || (error.retryAt !== null && error.retryAt > now()))) {
        continue
      }
    }
    planned.set(stableKey, { ...target, stableKey, fence: cache.beginRequest(target.ref) })
  }
  return [...planned.values()]
}
