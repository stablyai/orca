/** Fetch through four pooled calls, share each legacy authority answer across its entries, and publish only responses that pass the cache fence. */

import type { Automation } from '../../../../shared/automations-types'
import type { AutomationListScopeSelector } from '../../../../shared/automation-list-scope'
import type { LegacyAutomationPartitionContext } from '../../../../shared/automation-legacy-list-partition'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import {
  automationAuthorityCatalogKey,
  type AutomationHostQuerySupport
} from './automation-host-catalog-types'
import type { AutomationHostCache } from './automation-host-cache'
import type { AutomationHostRow } from './automation-host-cache-types'
import {
  partitionLegacyAutomationHostRows,
  toScopedAutomationHostRows
} from './automation-host-cache-rows'
import {
  AutomationHostScopeUnsupportedError,
  listLegacyAutomations,
  listScopedAutomations,
  type ScopedAutomationList
} from './automation-scoped-list-client'
import {
  createAutomationHostRequestPool,
  type AutomationHostRequestPool
} from './automation-host-scheduler-queue'
import type { AutomationHostDiagnostics } from './automation-host-diagnostics'
import { createAutomationHostRequestInstrumentation } from './automation-host-request-instrumentation'
import { createAutomationHostRetrySchedule } from './automation-host-retry-schedule'
import {
  planAutomationHostRequests,
  type PlannedAutomationHostTarget
} from './automation-host-scheduler-plan'

export type AutomationHostFetchTarget = {
  ref: StableAutomationCatalogRef
  /** Incarnation-bearing authority; its pairing revision pins the request. */
  authority: AutomationAuthorityRef
  /** The entry's fenceable owner, or null for a ghost/unhydrated/legacy entry. */
  owner: AutomationOwnerRef | null
  querySupport: AutomationHostQuerySupport
  /** The selected host and Desktop + Self jump the queue. */
  priority?: boolean
}

export type AutomationHostSchedulerTransport = {
  listScoped: (
    authority: AutomationAuthorityRef,
    selector: AutomationListScopeSelector
  ) => Promise<ScopedAutomationList>
  listLegacy: (authority: AutomationAuthorityRef) => Promise<Automation[]>
}

export type AutomationHostSchedulerOptions = {
  cache: AutomationHostCache
  legacyPartitionContext: (
    authority: StableAutomationAuthorityRef
  ) => LegacyAutomationPartitionContext
  transport?: Partial<AutomationHostSchedulerTransport>
  concurrency?: number
  now?: () => number
  random?: () => number
  isVisible?: () => boolean
  scheduleRetry?: (run: () => void, delayMs: number) => () => void
  diagnostics?: AutomationHostDiagnostics
  /** Wall clock for request duration; separate from `now`, which fake time drives. */
  elapsed?: () => number
}

export type AutomationHostRefreshOptions = {
  /** Skips freshness and cooldown, and supersedes anything already in flight. */
  force?: boolean
  /** Manual All-host refresh: leaves entries whose last error cannot succeed on a retry. */
  skipKnownFailures?: boolean
}

export type AutomationHostScheduler = {
  refresh: (
    targets: readonly AutomationHostFetchTarget[],
    options?: AutomationHostRefreshOptions
  ) => Promise<void>
  /** Manual retry: bypasses the cooldown and starts one new attempt. */
  retry: (target: AutomationHostFetchTarget) => Promise<void>
  cancelQueued: () => void
  inFlight: () => number
  dispose: () => void
}

type PlannedTarget = PlannedAutomationHostTarget

function scopeSelectorFor(target: AutomationHostFetchTarget): AutomationListScopeSelector | null {
  const selector = target.ref.selector
  if (selector.kind === 'self' || selector.kind === 'orphan') {
    return { kind: selector.kind }
  }
  // Unregistered SSH scopes cannot be fenced; the authority’s orphan scope supplies those records.
  return target.owner?.selector.kind === 'ssh'
    ? {
        kind: 'ssh',
        targetId: target.owner.selector.targetId,
        expectedTargetGeneration: target.owner.selector.targetGeneration
      }
    : null
}

export function createAutomationHostScheduler(
  options: AutomationHostSchedulerOptions
): AutomationHostScheduler {
  const cache = options.cache
  const now = options.now ?? Date.now
  const isVisible = options.isVisible ?? (() => document.visibilityState !== 'hidden')
  const listScoped = options.transport?.listScoped ?? listScopedAutomations
  const listLegacy = options.transport?.listLegacy ?? listLegacyAutomations
  const scheduleRetry =
    options.scheduleRetry ??
    ((run, delayMs) => {
      const handle = setTimeout(run, delayMs)
      return () => clearTimeout(handle)
    })
  const pool: AutomationHostRequestPool = createAutomationHostRequestPool(options.concurrency)
  const instrument = createAutomationHostRequestInstrumentation(
    options.diagnostics,
    options.elapsed
  )
  let disposed = false

  const retries = createAutomationHostRetrySchedule({
    cache,
    now,
    random: options.random,
    isVisible,
    scheduleRetry,
    retry: (target) => void refresh([target], { force: true })
  })

  const stillCurrent = (target: PlannedTarget): boolean =>
    !disposed &&
    cache.getByKey(target.stableKey)?.requestGeneration === target.fence.requestGeneration

  /** Count rejected entries separately from discarded requests: a legacy response is discarded only if none of its entries committed. */
  const settleGroup = (
    live: readonly PlannedTarget[],
    stableKey: string | null,
    outcome: 'commit' | 'failure',
    apply: (target: PlannedTarget) => boolean
  ): void => {
    let landed = 0
    for (const target of live) {
      if (apply(target)) {
        landed += 1
      } else {
        instrument.entryDiscarded(target.fence)
      }
    }
    if (landed === 0) {
      instrument.requestDiscarded(live[0].fence, stableKey, outcome)
    }
  }

  const runScoped = async (target: PlannedTarget): Promise<void> => {
    if (!stillCurrent(target)) {
      return
    }
    const selector = scopeSelectorFor(target)
    if (!selector) {
      // Nothing will ever answer for this entry, so its marker has to go too.
      cache.abandonRequest(target.fence)
      return
    }
    // Count at send, not submission; cancelled queued jobs never consumed wire traffic.
    instrument.request(target.fence, 'scoped')
    const startedAt = instrument.startedAt()
    try {
      const result = await listScoped(target.authority, selector)
      const rows = toScopedAutomationHostRows(target.authority, result)
      instrument.response(target.fence, target.stableKey, startedAt, rows.length, result)
      settleGroup([target], target.stableKey, 'commit', (entry) =>
        cache.commit(entry.fence, { rows, orphanCount: result.orphanCount })
      )
    } catch (error) {
      instrument.failed(target.fence, target.stableKey, startedAt)
      settleGroup([target], target.stableKey, 'failure', (entry) => retries.record(entry, error))
    }
  }

  const runLegacyAuthority = async (targets: readonly PlannedTarget[]): Promise<void> => {
    const live = targets.filter(stillCurrent)
    if (live.length === 0) {
      return
    }
    const authority = live[0].authority
    instrument.request(live[0].fence, 'legacy')
    const startedAt = instrument.startedAt()
    try {
      const automations = await listLegacy(authority)
      // Attributed to the authority alone: one answer serves every entry in the group.
      instrument.response(live[0].fence, null, startedAt, automations.length, automations)
      const partition = partitionLegacyAutomationHostRows(
        automations,
        live.map((target) => target.ref),
        options.legacyPartitionContext(live[0].ref.authority),
        hostStableKey
      )
      const rowsFor = (target: PlannedTarget): readonly AutomationHostRow[] =>
        partition.rowsByStableKey.get(target.stableKey) ?? []
      // Attribute legacy response rows per host even though the wire call belongs only to the authority.
      for (const target of live) {
        instrument.entryRows(target.stableKey, rowsFor(target).length)
      }
      // Report authority orphan counts on every entry; requiring an orphan request would prevent its entry from bootstrapping.
      settleGroup(live, null, 'commit', (target) =>
        cache.commit(target.fence, { rows: rowsFor(target), orphanCount: partition.orphanCount })
      )
    } catch (error) {
      instrument.failed(live[0].fence, null, startedAt)
      settleGroup(live, null, 'failure', (target) => retries.record(target, error))
    }
  }

  /** Hands back the markers of queued work the pool dropped before sending it. */
  const abandon = (targets: readonly PlannedTarget[]): void => {
    for (const target of targets) {
      cache.abandonRequest(target.fence)
    }
  }

  const refresh = async (
    targets: readonly AutomationHostFetchTarget[],
    refreshOptions: AutomationHostRefreshOptions = {}
  ): Promise<void> => {
    if (disposed) {
      return
    }
    const force = refreshOptions.force === true
    const joined: Promise<void>[] = []
    const counted = new Set<string>()
    for (const target of force ? [] : targets) {
      // Deduplicate raw refs before counting joins; repeated entries share one promise.
      const stableKey = hostStableKey(target.ref)
      if (counted.has(stableKey)) {
        continue
      }
      counted.add(stableKey)
      const pending = cache.pendingRequest(target.ref)
      if (!pending) {
        continue
      }
      instrument.dedupeHit(target.ref, target.querySupport)
      joined.push(pending)
    }
    const planned = planAutomationHostRequests({
      cache,
      targets,
      force,
      skipKnownFailures: refreshOptions.skipKnownFailures === true,
      now
    })
    const incompatible = planned.filter((target) => target.querySupport === 'incompatible')
    for (const target of incompatible) {
      retries.record(
        target,
        new AutomationHostScopeUnsupportedError(
          'This host is too old to list automations. Update the HUB and try again.'
        )
      )
    }
    const fetchable = planned.filter((target) => target.querySupport !== 'incompatible')
    const legacyByAuthority = new Map<string, PlannedTarget[]>()
    const submitted: Promise<void>[] = [...joined]
    for (const target of fetchable) {
      if (target.querySupport === 'legacy-unscoped') {
        const key = automationAuthorityCatalogKey(target.ref.authority)
        legacyByAuthority.set(key, [...(legacyByAuthority.get(key) ?? []), target])
        continue
      }
      const request = pool.submit({
        priority: target.priority,
        run: () => runScoped(target),
        cancel: () => abandon([target])
      })
      cache.trackRequest(target.fence, request)
      submitted.push(request)
    }
    for (const group of legacyByAuthority.values()) {
      // One request for the whole authority; every entry in the group shares it.
      const request = pool.submit({
        priority: group.some((target) => target.priority === true),
        run: () => runLegacyAuthority(group),
        cancel: () => abandon(group)
      })
      for (const target of group) {
        cache.trackRequest(target.fence, request)
      }
      submitted.push(request)
    }
    await Promise.all(submitted)
  }

  return {
    refresh,
    retry: async (target) => {
      retries.cancel(hostStableKey(target.ref))
      await refresh([{ ...target, priority: true }], { force: true })
    },
    cancelQueued: () => pool.cancelQueued(),
    inFlight: () => pool.inFlight(),
    dispose: () => {
      disposed = true
      pool.cancelQueued()
      retries.dispose()
    }
  }
}
