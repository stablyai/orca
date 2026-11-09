/** Enforce four pooled calls, one legacy authority call per cycle and no run-history fetch to fill missing usage. */

import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations/automation-definition'

import type {
  AutomationAuthorityRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automations/ownership/automation-owner-ref'
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

function stableAuthority(authority: AutomationAuthorityRef): StableAutomationAuthorityRef {
  return authority.kind === 'desktop'
    ? { kind: 'desktop' }
    : { kind: 'runtime', environmentId: authority.environmentId }
}

function selfRef(authority: AutomationAuthorityRef): StableAutomationCatalogRef {
  return { authority: stableAuthority(authority), selector: { kind: 'self' } }
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

describe('automation host scheduler legacy path', () => {
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
  // Manual All-hosts refresh bypasses TTL but leaves permanent failures to their own Retry.

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
