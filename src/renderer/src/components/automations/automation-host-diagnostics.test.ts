/** Exercise real cache/scheduler accounting. Count legacy wire requests once per authority, entries separately, and reject stale responses without inflating one request into many. */

import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'

import { hostStableKey } from '../../../../shared/automation-owner-key'

import type {
  AutomationAuthorityRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import type { AutomationHostQuerySupport } from './automation-host-catalog-types'
import {
  createAutomationHostDiagnostics,
  type AutomationHostDiagnostics
} from './automation-host-diagnostics'
import {
  createAutomationHostScheduler,
  type AutomationHostFetchTarget,
  type AutomationHostSchedulerOptions
} from './automation-host-scheduler'
import type { ScopedAutomationList } from './automation-scoped-list-client'

const callRuntimeRpc = vi.fn()
const getRuntimeEnvironmentStatus = vi.fn()

// Only capability-probe tests use the real list client; other cases inject transports.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: (...args: unknown[]) => getRuntimeEnvironmentStatus(...args)
}))

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

function sshRef(authority: AutomationAuthorityRef, targetId: string): StableAutomationCatalogRef {
  return {
    authority: stableAuthority(authority),
    selector: { kind: 'ssh', targetId }
  }
}

function target(
  ref: StableAutomationCatalogRef,
  options: {
    authority?: AutomationAuthorityRef
    querySupport?: AutomationHostQuerySupport
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
              targetGeneration: 2
            }
          }
        : { authority, selector: { kind: 'self' } },
    querySupport: options.querySupport ?? 'scoped'
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
    items: ids.map((id) => ({
      automationId: id,
      selector: { kind: 'self' as const }
    })),
    orphanCount: 0,
    invalidRows: 0
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const LOCAL_REPO = { repoConnectionId: () => null, projectsAuthoritative: true }

function harness(): {
  cache: AutomationHostCache
  diagnostics: AutomationHostDiagnostics
  schedule: (
    overrides: Partial<AutomationHostSchedulerOptions>
  ) => ReturnType<typeof createAutomationHostScheduler>
} {
  const diagnostics = createAutomationHostDiagnostics()
  const cache = createAutomationHostCache({
    catalogGeneration: () => 0,
    connectionGeneration: () => 0
  })
  return {
    cache,
    diagnostics,
    schedule: (overrides) =>
      createAutomationHostScheduler({
        cache,
        diagnostics,
        legacyPartitionContext: () => LOCAL_REPO,
        isVisible: () => true,
        // Disable retries so counters describe one cycle without timer-driven later requests.
        scheduleRetry: () => () => {},
        ...overrides
      })
  }
}

describe('automation host request counters', () => {
  it('records a dedupe hit, not a request, when a caller joins one in flight', async () => {
    const { diagnostics, schedule } = harness()
    const gate = deferred<ScopedAutomationList>()
    const listScoped = vi.fn(() => gate.promise)
    const scheduler = schedule({ transport: { listScoped } })

    const first = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])
    await Promise.resolve()
    const second = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])
    gate.resolve(scopedResult(['a']))
    await Promise.all([first, second])

    const key = hostStableKey(selfRef(RUNTIME_AUTHORITY))
    expect(listScoped).toHaveBeenCalledTimes(1)
    expect(diagnostics.snapshot().byStableKey[key]).toMatchObject({
      requests: 1,
      dedupeHits: 1
    })
  })

  it('never records a request for a host it refuses to call', async () => {
    const { diagnostics, schedule } = harness()
    const listScoped = vi.fn()
    const scheduler = schedule({ transport: { listScoped } })

    await scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY), { querySupport: 'incompatible' })])

    expect(listScoped).not.toHaveBeenCalled()
    // A local refusal is not wire traffic, and its failure is not a discard.
    expect(diagnostics.snapshot().totals).toMatchObject({
      requests: 0,
      failures: 0,
      discardedFailures: 0,
      discardedEntries: 0
    })
  })

  // The pool drops queued work the catalog has made obsolete, so counting at
  // submission would bill a host switch for calls that were never sent.
  it('does not count a queued request that was cancelled before it was sent', async () => {
    const { diagnostics, schedule } = harness()
    const gate = deferred<ScopedAutomationList>()
    const listScoped = vi.fn(() => gate.promise)
    const scheduler = schedule({ concurrency: 1, transport: { listScoped } })

    const pending = scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY)),
      target(sshRef(RUNTIME_AUTHORITY, 'target-1'))
    ])
    await Promise.resolve()
    scheduler.cancelQueued()
    gate.resolve(scopedResult(['a']))
    await pending

    expect(listScoped).toHaveBeenCalledTimes(1)
    expect(diagnostics.snapshot().totals.requests).toBe(1)
  })
})

describe('automation host diagnostics bookkeeping', () => {
  it('bounds tracked keys so a long session cannot grow without limit', () => {
    const diagnostics = createAutomationHostDiagnostics(2)
    for (const key of ['k1', 'k2', 'k3']) {
      diagnostics.recordRequest({
        authorityKey: 'a',
        stableKey: key,
        transport: 'scoped'
      })
    }
    const snapshot = diagnostics.snapshot()
    expect(Object.keys(snapshot.byStableKey)).toEqual(['k2', 'k3'])
    // Eviction preserves cumulative totals, so summed per-key buckets are only a lower bound.
    expect(snapshot.totals.requests).toBe(3)
  })
})
