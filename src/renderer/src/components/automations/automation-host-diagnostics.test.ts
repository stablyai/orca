/**
 * The counters are only worth having if they are driven by the real cache and
 * scheduler, so these run the instrumentation through both. The design doc's
 * release gate is stated over exactly these numbers: calls per authority, one
 * legacy call per authority per cycle, and stale responses that never landed.
 *
 * The distinction these tests exist to hold down is request versus entry. A
 * legacy answer is one request serving many hosts, so a counter that increments
 * per entry would fail the "one call per authority" gate for a system behaving
 * exactly as designed, and would inflate one stale answer into a dozen.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationListScopeSelector } from '../../../../shared/automation-list-scope'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import { AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  AutomationAuthorityRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import type { AutomationHostQuerySupport } from './automation-host-catalog-types'
import {
  automationHostDiagnostics,
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

// Only the capability-probe suite reaches the real list client; every other test
// injects a transport, so this mock stands in for a paired host that answers.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  getRuntimeEnvironmentStatus: (...args: unknown[]) => getRuntimeEnvironmentStatus(...args),
  hasRuntimeRpcErrorCode: () => false
}))

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
const LEGACY = { querySupport: 'legacy-unscoped' as const }

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

function orphanRef(authority: AutomationAuthorityRef): StableAutomationCatalogRef {
  return { authority: stableAuthority(authority), selector: { kind: 'orphan' } }
}

function authorityKeyOf(authority: AutomationAuthorityRef): string {
  return automationAuthorityCatalogKey(stableAuthority(authority))
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
        // A retry that never runs: these assert what one cycle cost, and a live
        // timer would re-enter the counters after the test read them.
        scheduleRetry: () => () => {},
        ...overrides
      })
  }
}

describe('automation host request counters', () => {
  it('attributes each scoped call to both its authority and its stable key', async () => {
    const { diagnostics, schedule } = harness()
    const scheduler = schedule({
      transport: { listScoped: vi.fn(() => Promise.resolve(scopedResult(['a', 'b']))) }
    })

    await scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY)),
      target(sshRef(RUNTIME_AUTHORITY, 'target-1')),
      target(selfRef(OTHER_AUTHORITY), { authority: OTHER_AUTHORITY })
    ])

    const snapshot = diagnostics.snapshot()
    expect(snapshot.totals.requests).toBe(3)
    expect(snapshot.totals.scopedRequests).toBe(3)
    expect(snapshot.byAuthority[authorityKeyOf(RUNTIME_AUTHORITY)].requests).toBe(2)
    expect(snapshot.byAuthority[authorityKeyOf(OTHER_AUTHORITY)].requests).toBe(1)
    expect(snapshot.byStableKey[hostStableKey(selfRef(RUNTIME_AUTHORITY))].requests).toBe(1)
  })

  // The doc's old-server budget in one number: three entries on one authority
  // must still cost one call, and it must be attributable to that authority.
  it('counts one legacy call per authority per cycle, not one per entry', async () => {
    const { diagnostics, schedule } = harness()
    const listLegacy = vi.fn(() => Promise.resolve([automation('self-1')]))
    const scheduler = schedule({ transport: { listLegacy } })

    const refs = [
      selfRef(RUNTIME_AUTHORITY),
      sshRef(RUNTIME_AUTHORITY, 'target-1'),
      orphanRef(RUNTIME_AUTHORITY)
    ]
    await scheduler.refresh(refs.map((ref) => target(ref, LEGACY)))

    const snapshot = diagnostics.snapshot()
    expect(listLegacy).toHaveBeenCalledTimes(1)
    expect(snapshot.byAuthority[authorityKeyOf(RUNTIME_AUTHORITY)].legacyRequests).toBe(1)
    // A legacy answer belongs to no single entry, so no key may claim the call
    // even though each key is credited with the rows it took from that answer.
    for (const ref of refs) {
      expect(snapshot.byStableKey[hostStableKey(ref)]).toMatchObject({
        requests: 0,
        legacyRequests: 0,
        responses: 0
      })
    }
  })

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

  // A legacy request is unkeyed, so its dedupe hits must be too — otherwise a
  // legacy host reads 0 requests against N hits and no per-key invariant holds.
  it('keys a legacy dedupe hit the same way it keys the legacy request', async () => {
    const { diagnostics, schedule } = harness()
    const gate = deferred<Automation[]>()
    const scheduler = schedule({ transport: { listLegacy: vi.fn(() => gate.promise) } })

    const first = scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY), LEGACY),
      target(sshRef(RUNTIME_AUTHORITY, 'target-1'), LEGACY)
    ])
    await Promise.resolve()
    const second = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY), LEGACY)])
    gate.resolve([automation('a')])
    await Promise.all([first, second])

    const snapshot = diagnostics.snapshot()
    const authority = snapshot.byAuthority[authorityKeyOf(RUNTIME_AUTHORITY)]
    expect(authority).toMatchObject({ legacyRequests: 1, dedupeHits: 1 })
    expect(snapshot.byStableKey[hostStableKey(selfRef(RUNTIME_AUTHORITY))].dedupeHits).toBe(0)
  })

  it('counts one hit when the same host appears twice in one refresh', async () => {
    const { diagnostics, schedule } = harness()
    const gate = deferred<ScopedAutomationList>()
    const scheduler = schedule({ transport: { listScoped: vi.fn(() => gate.promise) } })

    const ref = selfRef(RUNTIME_AUTHORITY)
    const first = scheduler.refresh([target(ref)])
    await Promise.resolve()
    // plan() collapses the duplicate into one entry; both share one promise.
    const second = scheduler.refresh([target(ref), target(ref)])
    gate.resolve(scopedResult(['a']))
    await Promise.all([first, second])

    expect(diagnostics.snapshot().byStableKey[hostStableKey(ref)].dedupeHits).toBe(1)
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

  // A cancelled job leaves nothing to join, so the refresh that follows is a new
  // request — counting it as a dedupe hit would credit a call never sent.
  it('does not count a dedupe hit against a cancelled queued request', async () => {
    const { diagnostics, schedule } = harness()
    const gate = deferred<ScopedAutomationList>()
    const listScoped = vi.fn(() => gate.promise)
    const scheduler = schedule({ concurrency: 1, transport: { listScoped } })

    const cancelled = sshRef(RUNTIME_AUTHORITY, 'target-1')
    const pending = scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY)), target(cancelled)])
    await Promise.resolve()
    scheduler.cancelQueued()
    gate.resolve(scopedResult(['a']))
    await pending

    await scheduler.refresh([target(cancelled)])
    expect(diagnostics.snapshot().byStableKey[hostStableKey(cancelled)]).toMatchObject({
      dedupeHits: 0,
      requests: 1
    })
  })
})

describe('unpooled capability probes', () => {
  beforeEach(async () => {
    callRuntimeRpc.mockReset()
    getRuntimeEnvironmentStatus.mockReset()
    automationHostDiagnostics.reset()
    // Confirmed capabilities are module-level and must not leak between tests.
    ;(await import('./automation-scoped-list-client')).resetAutomationCapabilityProbes()
  })

  // The probe rides outside the four-slot pool, so an instrument blind to it
  // would under-report relay traffic. It dedupes per authority incarnation:
  // both hosts of this authority ride on one status.get.
  it('counts the status.get probe runtime-scoped lists ride on', async () => {
    const { cache } = harness()
    getRuntimeEnvironmentStatus.mockResolvedValue({
      capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY]
    })
    callRuntimeRpc.mockImplementation((_target: unknown, _method: unknown, params: unknown) => {
      const selector = (params as { selector: AutomationListScopeSelector }).selector
      return Promise.resolve({
        automations: [{ id: 'a' }],
        items: [{ automationId: 'a', selector }],
        orphanCount: 0
      })
    })
    // No injected transport: this is the one suite that drives the real client.
    const scheduler = createAutomationHostScheduler({
      cache,
      legacyPartitionContext: () => LOCAL_REPO,
      isVisible: () => true
    })

    await scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY)),
      target(sshRef(RUNTIME_AUTHORITY, 'target-1'))
    ])

    const authority =
      automationHostDiagnostics.snapshot().byAuthority[authorityKeyOf(RUNTIME_AUTHORITY)]
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
    // Two pooled list calls, and the one shared round trip the pool never sees.
    expect(authority).toMatchObject({ requests: 2, capabilityProbes: 1 })
  })
})

describe('automation host stale-response counters', () => {
  it('counts a commit the fence threw away, and still counts the rows it cost', async () => {
    const { cache, diagnostics, schedule } = harness()
    const gate = deferred<ScopedAutomationList>()
    const scheduler = schedule({ transport: { listScoped: vi.fn(() => gate.promise) } })

    const ref = selfRef(RUNTIME_AUTHORITY)
    const pending = scheduler.refresh([target(ref)])
    await Promise.resolve()
    // The user left this host while its answer was still on the wire.
    cache.invalidate(ref)
    gate.resolve(scopedResult(['a', 'b']))
    await pending

    const counters = diagnostics.snapshot().byStableKey[hostStableKey(ref)]
    expect(cache.get(ref)?.data).toEqual([])
    expect(counters).toMatchObject({ discardedCommits: 1, discardedEntries: 1 })
    // Recorded even though nothing landed: the wire cost was paid regardless.
    expect(counters.rows).toBe(2)
  })

  it('separates a discarded failure from a discarded commit', async () => {
    const { cache, diagnostics, schedule } = harness()
    const gate = deferred<ScopedAutomationList>()
    const scheduler = schedule({ transport: { listScoped: vi.fn(() => gate.promise) } })

    const ref = selfRef(RUNTIME_AUTHORITY)
    const pending = scheduler.refresh([target(ref)])
    await Promise.resolve()
    cache.invalidate(ref)
    gate.reject(new Error('host went away'))
    await pending

    expect(diagnostics.snapshot().byStableKey[hostStableKey(ref)]).toMatchObject({
      discardedCommits: 0,
      discardedFailures: 1,
      // The attempt still happened and still took time, fence or no fence.
      failures: 1
    })
  })

  // One stale legacy answer is one discarded request over many discarded
  // entries. Counting it per entry would report twelve stale responses for a
  // twelve-host authority that received exactly one.
  it('counts a stale legacy answer once as a request and once per entry', async () => {
    const { cache, diagnostics, schedule } = harness()
    const gate = deferred<Automation[]>()
    const scheduler = schedule({ transport: { listLegacy: vi.fn(() => gate.promise) } })

    const refs = [
      selfRef(RUNTIME_AUTHORITY),
      sshRef(RUNTIME_AUTHORITY, 'target-1'),
      orphanRef(RUNTIME_AUTHORITY)
    ]
    const pending = scheduler.refresh(refs.map((ref) => target(ref, LEGACY)))
    await Promise.resolve()
    // The whole authority re-paired while its one answer was in flight.
    cache.invalidateAuthority(stableAuthority(RUNTIME_AUTHORITY))
    gate.resolve([automation('a')])
    await pending

    expect(diagnostics.snapshot().byAuthority[authorityKeyOf(RUNTIME_AUTHORITY)]).toMatchObject({
      responses: 1,
      discardedCommits: 1,
      discardedEntries: 3
    })
  })

  // The gate `discardedCommits === 0` has to stay assertable for a system that
  // is behaving: an answer that landed somewhere was not thrown away.
  it('does not call a legacy answer discarded when one of its entries landed', async () => {
    const { cache, diagnostics, schedule } = harness()
    const gate = deferred<Automation[]>()
    const scheduler = schedule({ transport: { listLegacy: vi.fn(() => gate.promise) } })

    const stale = sshRef(RUNTIME_AUTHORITY, 'target-1')
    const pending = scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY), LEGACY),
      target(stale, LEGACY)
    ])
    await Promise.resolve()
    cache.invalidate(stale)
    gate.resolve([automation('a')])
    await pending

    expect(diagnostics.snapshot().byAuthority[authorityKeyOf(RUNTIME_AUTHORITY)]).toMatchObject({
      discardedCommits: 0,
      discardedEntries: 1
    })
  })
})

describe('automation host response measurements', () => {
  it('records row counts and refresh duration per response', async () => {
    const { diagnostics, schedule } = harness()
    const ticks = [100, 145, 200, 320]
    let tick = 0
    const scheduler = schedule({
      elapsed: () => ticks[Math.min(tick++, ticks.length - 1)],
      concurrency: 1,
      transport: { listScoped: vi.fn(() => Promise.resolve(scopedResult(['a', 'b', 'c']))) }
    })

    await scheduler.refresh([
      target(selfRef(RUNTIME_AUTHORITY)),
      target(sshRef(RUNTIME_AUTHORITY, 'target-1'))
    ])

    const totals = diagnostics.snapshot().totals
    expect(totals.responses).toBe(2)
    expect(totals.rows).toBe(6)
    expect(totals.durationMsTotal).toBe(45 + 120)
    expect(totals.durationMsMax).toBe(120)
  })

  // A host that times out is the slowest thing a refresh does. Recording
  // duration only on success hides exactly the requests worth finding.
  it('records the duration of a request that failed', async () => {
    const { diagnostics, schedule } = harness()
    const ticks = [100, 175]
    let tick = 0
    const scheduler = schedule({
      elapsed: () => ticks[Math.min(tick++, ticks.length - 1)],
      concurrency: 1,
      transport: { listScoped: vi.fn(() => Promise.reject(new Error('timed out'))) }
    })

    await scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])

    expect(diagnostics.snapshot().totals).toMatchObject({
      responses: 0,
      failures: 1,
      durationMsTotal: 75,
      durationMsMax: 75
    })
  })

  // Doc 416 asks for row counts per host, and the legacy fan-out is where they
  // would otherwise be lost — precisely where the payload is largest.
  it('attributes legacy rows to each host, not only to the authority', async () => {
    const { diagnostics, schedule } = harness()
    const scheduler = schedule({
      transport: {
        listLegacy: vi.fn(() =>
          Promise.resolve([automation('a'), automation('b'), automation('c')])
        )
      }
    })

    const self = selfRef(RUNTIME_AUTHORITY)
    const ssh = sshRef(RUNTIME_AUTHORITY, 'target-1')
    await scheduler.refresh([target(self, LEGACY), target(ssh, LEGACY)])

    const snapshot = diagnostics.snapshot()
    // The authority's number is what the response carried...
    expect(snapshot.byAuthority[authorityKeyOf(RUNTIME_AUTHORITY)].rows).toBe(3)
    // ...and each key's is what that host took from it, request or no request.
    expect(snapshot.byStableKey[hostStableKey(self)]).toMatchObject({ rows: 3, requests: 0 })
    expect(snapshot.byStableKey[hostStableKey(ssh)].rows).toBe(0)
  })

  // Sizing re-serializes a payload the transport already decoded, so it stays
  // off unless someone is profiling. The flag keeps an unmeasured zero from
  // reading as a real one.
  it('leaves response size unmeasured until measurement is turned on', async () => {
    const { diagnostics, schedule } = harness()
    const scheduler = schedule({
      transport: { listScoped: vi.fn(() => Promise.resolve(scopedResult(['a']))) }
    })

    await scheduler.refresh([target(selfRef(RUNTIME_AUTHORITY))])
    expect(diagnostics.snapshot()).toMatchObject({
      serializedCharsMeasured: false,
      totals: { approxSerializedChars: 0 }
    })

    diagnostics.setMeasureSerializedChars(true)
    await scheduler.refresh([target(sshRef(RUNTIME_AUTHORITY, 'target-1'))])
    const measured = diagnostics.snapshot()
    expect(measured.serializedCharsMeasured).toBe(true)
    expect(measured.totals.approxSerializedChars).toBeGreaterThan(0)
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
    // Evicting a key must not rewrite history: the totals still saw three calls.
    // This is also why sum(byStableKey) is a lower bound on totals, not an equality.
    expect(snapshot.totals.requests).toBe(3)
  })

  it('clears every bucket on reset so a profiling run starts from zero', () => {
    const diagnostics = createAutomationHostDiagnostics()
    diagnostics.recordRequest({
      authorityKey: 'a',
      stableKey: 'k1',
      transport: 'legacy'
    })
    diagnostics.recordDedupeHit({ authorityKey: 'a', stableKey: 'k1' })
    diagnostics.reset()
    expect(diagnostics.snapshot()).toMatchObject({
      totals: { requests: 0, dedupeHits: 0, legacyRequests: 0 },
      byAuthority: {},
      byStableKey: {}
    })
  })

  it('never copies an automation, a prompt, or a name into a counter', () => {
    const diagnostics = createAutomationHostDiagnostics()
    diagnostics.recordResponse({
      authorityKey: 'a',
      stableKey: 'k1',
      rows: 3,
      durationMs: 12,
      approxSerializedChars: 900
    })
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/prompt|automation-|secret/i)
  })
})
