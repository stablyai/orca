/**
 * The scheduler's budget is the contract: four calls in flight, one unscoped
 * call per old authority per cycle, and no run-history fetch to paper over the
 * usage an old response cannot carry.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationListScopeSelector } from '../../../../shared/automation-list-scope'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  AutomationAuthorityRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import type { AutomationHostQuerySupport } from './automation-host-catalog-types'
import {
  createAutomationHostScheduler,
  type AutomationHostFetchTarget
} from './automation-host-scheduler'
import type { ScopedAutomationList } from './automation-scoped-list-client'

const RUNTIME_AUTHORITY: AutomationAuthorityRef = {
  kind: 'runtime',
  environmentId: 'env-1',
  pairingRevision: 4
}
const OTHER_AUTHORITY: AutomationAuthorityRef = {
  kind: 'runtime',
  environmentId: 'env-2',
  pairingRevision: 1
}

function stableAuthority(authority: AutomationAuthorityRef): StableAutomationAuthorityRef {
  return authority.kind === 'desktop'
    ? { kind: 'desktop' }
    : { kind: 'runtime', environmentId: authority.environmentId }
}

function selfRef(authority: AutomationAuthorityRef): StableAutomationCatalogRef {
  return { authority: stableAuthority(authority), selector: { kind: 'self' } }
}

function sshRef(authority: AutomationAuthorityRef, targetId: string): StableAutomationCatalogRef {
  return { authority: stableAuthority(authority), selector: { kind: 'ssh', targetId } }
}

function target(
  ref: StableAutomationCatalogRef,
  options: {
    authority?: AutomationAuthorityRef
    querySupport?: AutomationHostQuerySupport
    targetGeneration?: number
    priority?: boolean
  } = {}
): AutomationHostFetchTarget {
  const authority = options.authority ?? RUNTIME_AUTHORITY
  return {
    ref,
    authority,
    owner:
      ref.selector.kind === 'ssh'
        ? {
            authority,
            selector: {
              kind: 'ssh',
              targetId: ref.selector.targetId,
              targetGeneration: options.targetGeneration ?? 2
            }
          }
        : { authority, selector: { kind: 'self' } },
    querySupport: options.querySupport ?? 'scoped',
    priority: options.priority
  }
}

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  return {
    id,
    name: id,
    projectId: 'repo-1',
    executionTargetType: 'local',
    ...overrides
  } as Automation
}

function scopedResult(ids: readonly string[]): ScopedAutomationList {
  return {
    automations: ids.map((id) => automation(id)),
    items: ids.map((id) => ({ automationId: id, selector: { kind: 'self' as const } })),
    orphanCount: 0,
    invalidRows: 0
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function createCache(now?: () => number): AutomationHostCache {
  return createAutomationHostCache({
    now,
    catalogGeneration: () => 0,
    connectionGeneration: () => 0
  })
}

const LOCAL_REPO = { repoConnectionId: () => null, projectsAuthoritative: true }

describe('automation host scheduler concurrency', () => {
  it('keeps at most four authority calls in flight', async () => {
    const cache = createCache()
    const gates = Array.from({ length: 8 }, () => deferred<ScopedAutomationList>())
    let started = 0
    const listScoped = vi.fn(() => gates[started++].promise)
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listScoped }
    })

    const targets = Array.from({ length: 8 }, (_, index) =>
      target(sshRef(RUNTIME_AUTHORITY, `target-${index}`))
    )
    const done = scheduler.refresh(targets)
    await Promise.resolve()
    expect(scheduler.inFlight()).toBe(4)
    expect(listScoped).toHaveBeenCalledTimes(4)

    for (const gate of gates) {
      gate.resolve(scopedResult([]))
      await Promise.resolve()
    }
    await done
    expect(listScoped).toHaveBeenCalledTimes(8)
  })

  it('runs the selected host before the rest of the queue', async () => {
    const cache = createCache()
    const order: string[] = []
    const listScoped = vi.fn((_authority, selector: AutomationListScopeSelector) => {
      order.push(selector.kind === 'ssh' ? selector.targetId : selector.kind)
      return Promise.resolve(scopedResult([]))
    })
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      concurrency: 1,
      transport: { listScoped }
    })
    await scheduler.refresh([
      target(sshRef(RUNTIME_AUTHORITY, 'a')),
      target(sshRef(RUNTIME_AUTHORITY, 'b')),
      target(sshRef(RUNTIME_AUTHORITY, 'selected'), { priority: true })
    ])
    expect(order[0]).toBe('a')
    expect(order[1]).toBe('selected')
  })

  it('shares one in-flight request between concurrent callers for the same owner', async () => {
    const cache = createCache()
    const gate = deferred<ScopedAutomationList>()
    const listScoped = vi.fn(() => gate.promise)
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listScoped }
    })
    const first = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])
    await Promise.resolve()
    const second = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])
    gate.resolve(scopedResult(['a']))
    await Promise.all([first, second])
    expect(listScoped).toHaveBeenCalledTimes(1)
  })

  // Ordinary startup: the catalog settles a moment after the first refresh, so the
  // re-apply cancels a queue full of hosts nothing else will ever ask for again.
  it('re-fetches queued work that was cancelled before it was sent', async () => {
    const cache = createCache()
    const gates: { resolve: (value: ScopedAutomationList) => void }[] = []
    const queried: string[] = []
    let blocking = true
    const listScoped = vi.fn((_authority: AutomationAuthorityRef, selector) => {
      queried.push(selector.kind === 'ssh' ? selector.targetId : selector.kind)
      if (!blocking) {
        return Promise.resolve(scopedResult([]))
      }
      const gate = deferred<ScopedAutomationList>()
      gates.push(gate)
      return gate.promise
    })
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      concurrency: 2,
      transport: { listScoped }
    })

    const targets = Array.from({ length: 5 }, (_, index) =>
      target(sshRef(RUNTIME_AUTHORITY, `target-${index}`))
    )
    const first = scheduler.refresh(targets)
    await Promise.resolve()
    expect(queried).toEqual(['target-0', 'target-1'])

    scheduler.cancelQueued()
    for (const gate of gates) {
      gate.resolve(scopedResult([]))
    }
    await first

    blocking = false
    await scheduler.refresh(targets)
    expect(queried).toEqual(['target-0', 'target-1', 'target-2', 'target-3', 'target-4'])
  })

  it('clears the request marker of a queued job the pool dropped', async () => {
    const cache = createCache()
    const gate = deferred<ScopedAutomationList>()
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      concurrency: 1,
      transport: { listScoped: () => gate.promise }
    })
    const queued = target(sshRef(RUNTIME_AUTHORITY, 'queued'))
    const done = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY)), queued])
    await Promise.resolve()

    scheduler.cancelQueued()
    expect(cache.get(queued.ref)?.request).toBeNull()
    gate.resolve(scopedResult([]))
    await done
  })

  // One legacy job answers for a whole authority, so cancelling it strands every
  // entry in the group, not just the one that happened to submit it.
  it('clears every marker of a cancelled legacy authority job', async () => {
    const cache = createCache()
    const gate = deferred<ScopedAutomationList>()
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      concurrency: 1,
      transport: { listScoped: () => gate.promise, listLegacy: () => Promise.resolve([]) }
    })
    const legacy = { querySupport: 'legacy-unscoped' as const, authority: OTHER_AUTHORITY }
    const group = [
      target(selfRef(OTHER_AUTHORITY), legacy),
      target(sshRef(OTHER_AUTHORITY, 'target-1'), legacy)
    ]
    const done = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY)), ...group])
    await Promise.resolve()

    scheduler.cancelQueued()
    expect(group.map((entry) => cache.get(entry.ref)?.request)).toEqual([null, null])
    gate.resolve(scopedResult([]))
    await done
  })

  it('clears the marker of a target it has no way to address', async () => {
    const cache = createCache()
    const listScoped = vi.fn()
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listScoped }
    })
    // A ghost SSH entry: no registration generation, so no selector can be fenced.
    const ghost = { ...target(sshRef(RUNTIME_AUTHORITY, 'ghost')), owner: null }
    await scheduler.refresh([ghost])

    expect(listScoped).not.toHaveBeenCalled()
    expect(cache.get(ghost.ref)?.request).toBeNull()
  })

  it('drops queued work whose entry was invalidated before it was sent', async () => {
    const cache = createCache()
    const gate = deferred<ScopedAutomationList>()
    const listScoped = vi.fn(() => gate.promise)
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      concurrency: 1,
      transport: { listScoped }
    })
    const queued = target(sshRef(RUNTIME_AUTHORITY, 'queued'))
    const done = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY)), queued])
    await Promise.resolve()
    cache.invalidate(queued.ref)
    gate.resolve(scopedResult([]))
    await done
    expect(listScoped).toHaveBeenCalledTimes(1)
  })
})

describe('automation host scheduler legacy path', () => {
  it('makes one unscoped call per authority per cycle and partitions it', async () => {
    const cache = createCache()
    const listRuns = vi.fn()
    vi.stubGlobal('window', { api: { automations: { listRuns } } })
    const listLegacy = vi.fn((authority: AutomationAuthorityRef) =>
      Promise.resolve(
        authority.kind === 'runtime' && authority.environmentId === 'env-1'
          ? [
              automation('self-1'),
              automation('ssh-1', {
                executionTargetType: 'ssh',
                executionTargetId: 'target-1'
              }),
              automation('broken', { executionTargetType: 'ssh' })
            ]
          : [automation('other-self')]
      )
    )
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listLegacy }
    })

    const legacy = { querySupport: 'legacy-unscoped' as const }
    await scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY), legacy),
      target(sshRef(RUNTIME_AUTHORITY, 'target-1'), legacy),
      target(
        { authority: stableAuthority(RUNTIME_AUTHORITY), selector: { kind: 'orphan' } },
        legacy
      ),
      target(selfRef(OTHER_AUTHORITY), { ...legacy, authority: OTHER_AUTHORITY })
    ])

    expect(listLegacy).toHaveBeenCalledTimes(2)
    const self = cache.get(selfRef(RUNTIME_AUTHORITY))
    expect(self?.data.map((row) => row.automation.id)).toEqual(['self-1'])
    expect(
      cache.get(sshRef(RUNTIME_AUTHORITY, 'target-1'))?.data.map((row) => row.automation.id)
    ).toEqual(['ssh-1'])
    const orphanEntry = cache.getByKey(
      hostStableKey({ authority: stableAuthority(RUNTIME_AUTHORITY), selector: { kind: 'orphan' } })
    )
    expect(orphanEntry?.data.map((row) => row.automation.id)).toEqual(['broken'])
    expect(orphanEntry?.orphanCount).toBe(1)
    vi.unstubAllGlobals()
    expect(listRuns).not.toHaveBeenCalled()
  })

  it('leaves legacy rows unfenced and their usage unavailable', async () => {
    const cache = createCache()
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listLegacy: () => Promise.resolve([automation('a')]) }
    })
    await scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY), { querySupport: 'legacy-unscoped' })
    ])
    const row = cache.get(selfRef(RUNTIME_AUTHORITY))?.data[0]
    expect(row?.owner).toBeNull()
    expect(row?.usageKnown).toBe(false)
    expect(row?.usageSummary).toBeNull()
  })

  it('records an incompatible host without sending anything', async () => {
    const cache = createCache()
    const listScoped = vi.fn()
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listScoped }
    })
    await scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY), { querySupport: 'incompatible' })])
    expect(listScoped).not.toHaveBeenCalled()
    expect(cache.get(selfRef(RUNTIME_AUTHORITY))?.error).toMatchObject({
      code: 'incompatible',
      retryable: false
    })
  })
})

describe('automation host scheduler revalidation', () => {
  it('skips a fresh entry and refetches once it is stale or forced', async () => {
    let clock = 1_000
    const cache = createCache(() => clock)
    const listScoped = vi.fn(() => Promise.resolve(scopedResult([])))
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      now: () => clock,
      transport: { listScoped }
    })
    const only = [target(selfRef(RUNTIME_AUTHORITY))]
    await scheduler.refresh(only)
    await scheduler.refresh(only)
    expect(listScoped).toHaveBeenCalledTimes(1)
    await scheduler.refresh(only, { force: true })
    expect(listScoped).toHaveBeenCalledTimes(2)
    clock += 30_001
    await scheduler.refresh(only)
    expect(listScoped).toHaveBeenCalledTimes(3)
  })

  it('retries a transient failure with jittered backoff and stops at the attempt cap', async () => {
    let clock = 0
    const cache = createCache(() => clock)
    const delays: number[] = []
    const listScoped = vi.fn(() => Promise.reject(new Error('runtime_unavailable')))
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      now: () => clock,
      random: () => 1,
      transport: { listScoped },
      scheduleRetry: (run, delayMs) => {
        delays.push(delayMs)
        void Promise.resolve().then(run)
        return () => {}
      }
    })
    await scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Full jitter with a 1s base: 1s then 2s, and no third retry once the cap is reached.
    expect(delays).toEqual([1_000, 2_000])
    expect(listScoped).toHaveBeenCalledTimes(3)
    expect(cache.get(selfRef(RUNTIME_AUTHORITY))?.error).toMatchObject({
      code: 'authority_unavailable',
      retryable: false
    })
  })

  it('does not schedule automatic retries while the page is hidden', async () => {
    const cache = createCache()
    const scheduleRetry = vi.fn(() => () => {})
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => false,
      transport: { listScoped: () => Promise.reject(new Error('runtime_unavailable')) },
      scheduleRetry
    })
    await scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])
    expect(scheduleRetry).not.toHaveBeenCalled()
  })

  it('lets a manual retry bypass the cooldown', async () => {
    let clock = 0
    const cache = createCache(() => clock)
    let calls = 0
    const listScoped = vi.fn(() => {
      calls += 1
      return calls === 1
        ? Promise.reject(new Error('runtime_unavailable'))
        : Promise.resolve(scopedResult(['a']))
    })
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      now: () => clock,
      random: () => 1,
      transport: { listScoped },
      scheduleRetry: () => () => {}
    })
    const only = target(selfRef(RUNTIME_AUTHORITY))
    await scheduler.refresh([only])
    // Still inside the backoff window, so an ordinary refresh is a no-op.
    await scheduler.refresh([only])
    expect(listScoped).toHaveBeenCalledTimes(1)
    await scheduler.retry(only)
    expect(listScoped).toHaveBeenCalledTimes(2)
    expect(cache.get(selfRef(RUNTIME_AUTHORITY))?.data).toHaveLength(1)
  })

  // Design doc: a manual All-host refresh bypasses TTL but does not enqueue
  // requests already known to fail; that host keeps its own Retry instead.
  it('leaves a permanently failed host out of a manual all-hosts refresh', async () => {
    const cache = createCache()
    let outcome: () => Promise<ScopedAutomationList> = () =>
      Promise.reject(new Error('permission_denied'))
    const listScoped = vi.fn(() => outcome())
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listScoped }
    })
    const only = target(selfRef(RUNTIME_AUTHORITY))
    await scheduler.refresh([only])
    expect(cache.get(only.ref)?.error).toMatchObject({
      code: 'permission_denied',
      retryable: false
    })

    await scheduler.refresh([only], { force: true, skipKnownFailures: true })
    expect(listScoped).toHaveBeenCalledTimes(1)

    outcome = () => Promise.resolve(scopedResult(['a']))
    await scheduler.retry(only)
    expect(listScoped).toHaveBeenCalledTimes(2)
  })

  it('lets a forced refresh supersede the request it replaces', async () => {
    const cache = createCache()
    const gates = [deferred<ScopedAutomationList>(), deferred<ScopedAutomationList>()]
    let started = 0
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listScoped: () => gates[started++].promise }
    })
    const only = target(selfRef(RUNTIME_AUTHORITY))
    const first = scheduler.refresh([only])
    await Promise.resolve()
    const second = scheduler.refresh([only], { force: true })
    await Promise.resolve()

    gates[1].resolve(scopedResult(['fresh']))
    gates[0].resolve(scopedResult(['stale']))
    await Promise.all([first, second])

    expect(cache.get(only.ref)?.data.map((row) => row.automation.id)).toEqual(['fresh'])
  })

  it('discards a response whose entry was invalidated while in flight', async () => {
    const cache = createCache()
    const gate = deferred<ScopedAutomationList>()
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true,
      transport: { listScoped: () => gate.promise }
    })
    const only = target(selfRef(RUNTIME_AUTHORITY))
    const done = scheduler.refresh([only])
    await Promise.resolve()
    cache.invalidate(only.ref)
    gate.resolve(scopedResult(['a']))
    await done
    expect(cache.get(only.ref)?.data).toEqual([])
  })
})
