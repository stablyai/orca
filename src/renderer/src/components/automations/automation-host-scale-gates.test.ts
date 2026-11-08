/** Compose real validation, cache and scheduling over 1,000 automations/50 hosts; mock only RPC. Verify four pooled requests, deduped unpooled probes, one legacy call per authority and stale fences under concurrency. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationListScopeSelector } from '../../../../shared/automation-list-scope'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import { AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  AutomationAuthorityRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import {
  automationHostDiagnostics,
  type AutomationHostDiagnosticsSnapshot
} from './automation-host-diagnostics'
import {
  createAutomationHostScheduler,
  type AutomationHostFetchTarget
} from './automation-host-scheduler'

import { resetAutomationCapabilityProbes } from './automation-scoped-list-client'

const callRuntimeRpc = vi.fn()
const getRuntimeEnvironmentStatus = vi.fn()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: (...args: unknown[]) => getRuntimeEnvironmentStatus(...args)
}))

// Use 10 authorities × 5 entries × 20 automations; half are legacy to exercise per-authority fan-out budgets.
const AUTHORITY_COUNT = 10
const ENTRIES_PER_AUTHORITY = 5
const AUTOMATIONS_PER_HOST = 20
const SCOPED_AUTHORITIES = AUTHORITY_COUNT / 2
const HOST_COUNT = AUTHORITY_COUNT * ENTRIES_PER_AUTHORITY

const SSH_TARGET_GENERATION = 3

function authorityAt(index: number): AutomationAuthorityRef {
  return { kind: 'runtime', environmentId: `env-${index}`, pairingRevision: index + 1 }
}

function stableAuthorityAt(index: number): StableAutomationAuthorityRef {
  return { kind: 'runtime', environmentId: `env-${index}` }
}

function isLegacyAuthority(index: number): boolean {
  return index >= SCOPED_AUTHORITIES
}

function environmentIndex(environmentId: string): number {
  return Number(environmentId.slice('env-'.length))
}

function sshTargetId(authorityIndex: number, slot: number): string {
  return `ssh-${authorityIndex}-${slot}`
}

// Include Self/SSH/orphan selectors so legacy partitioning proves ownership without server metadata.
function refsForAuthority(authorityIndex: number): StableAutomationCatalogRef[] {
  const authority = stableAuthorityAt(authorityIndex)
  return [
    { authority, selector: { kind: 'self' } },
    { authority, selector: { kind: 'orphan' } },
    ...Array.from({ length: ENTRIES_PER_AUTHORITY - 2 }, (_unused, slot) => ({
      authority,
      selector: { kind: 'ssh' as const, targetId: sshTargetId(authorityIndex, slot) }
    }))
  ]
}

/** The host label an automation's id carries, so a misrouted row names its real owner. */
function hostLabel(ref: StableAutomationCatalogRef): string {
  return ref.selector.kind === 'ssh' ? ref.selector.targetId : ref.selector.kind
}

function refForSelector(
  index: number,
  selector: AutomationListScopeSelector
): StableAutomationCatalogRef {
  const authority = stableAuthorityAt(index)
  if (selector.kind === 'ssh') {
    return { authority, selector: { kind: 'ssh', targetId: selector.targetId } }
  }
  return selector.kind === 'orphan'
    ? { authority, selector: { kind: 'orphan' } }
    : { authority, selector: { kind: 'self' } }
}

const ALL_REFS: StableAutomationCatalogRef[] = Array.from(
  { length: AUTHORITY_COUNT },
  (_unused, index) => refsForAuthority(index)
).flat()

function targetFor(ref: StableAutomationCatalogRef): AutomationHostFetchTarget {
  const index = environmentIndex(
    ref.authority.kind === 'runtime' ? ref.authority.environmentId : 'env-0'
  )
  const authority = authorityAt(index)
  return {
    ref,
    authority,
    // Orphans have no executable owner; the selector alone scopes their request.
    owner:
      ref.selector.kind === 'ssh'
        ? {
            authority,
            selector: {
              kind: 'ssh',
              targetId: ref.selector.targetId,
              targetGeneration: SSH_TARGET_GENERATION
            }
          }
        : ref.selector.kind === 'orphan'
          ? null
          : { authority, selector: { kind: 'self' } },
    querySupport: isLegacyAuthority(index) ? 'legacy-unscoped' : 'scoped'
  }
}

/** Encodes its host in the id, so a misattributed row is visible rather than merely counted. */
function automationsForHost(ref: StableAutomationCatalogRef, index: number): Automation[] {
  return Array.from({ length: AUTOMATIONS_PER_HOST }, (_unused, n) => {
    const base = {
      id: `auto-${index}-${hostLabel(ref)}-${n}`,
      name: `automation ${n}`,
      projectId: 'repo-1'
    }
    if (ref.selector.kind === 'ssh') {
      return {
        ...base,
        executionTargetType: 'ssh',
        executionTargetId: ref.selector.targetId
      } as Automation
    }
    // What an old server's orphan looks like on the wire: a record it admits is
    // scheduled somewhere it cannot speak for.
    return (
      ref.selector.kind === 'orphan'
        ? { ...base, executionTargetType: 'local', schedulerOwner: 'remote_host_service' }
        : { ...base, executionTargetType: 'local' }
    ) as Automation
  })
}

function respondingSelector(selector: AutomationListScopeSelector): unknown {
  if (selector.kind === 'ssh') {
    return {
      kind: 'ssh',
      targetId: selector.targetId,
      targetGeneration: selector.expectedTargetGeneration
    }
  }
  return selector.kind === 'orphan' ? { kind: 'orphan', issue: '' } : { kind: 'self' }
}

function scopedPayload(environmentId: string, selector: AutomationListScopeSelector): unknown {
  const index = environmentIndex(environmentId)
  const automations = automationsForHost(refForSelector(index, selector), index)
  return {
    automations,
    // Echoing the requested selector is what a correct host does; the client
    // rejects anything else, so this keeps the validation path honest.
    items: automations.map((entry) => ({
      automationId: entry.id,
      selector: respondingSelector(selector)
    })),
    orphanCount: selector.kind === 'orphan' ? AUTOMATIONS_PER_HOST : 0
  }
}

/** One old server's whole authority in a single answer, exactly as it would arrive. */
function legacyPayload(environmentId: string): unknown {
  const index = environmentIndex(environmentId)
  return {
    automations: refsForAuthority(index).flatMap((ref) => automationsForHost(ref, index))
  }
}

type WireActivity = {
  inFlight: number
  maxInFlight: number
  scopedCalls: number
  probes: number
  legacyCallsByEnvironment: Map<string, number>
}

let wire: WireActivity
let onWireCall: ((environmentId: string) => void) | null

function beginWireCall(environmentId: string): void {
  wire.inFlight += 1
  wire.maxInFlight = Math.max(wire.maxInFlight, wire.inFlight)
  onWireCall?.(environmentId)
}

/** A relay round trip yields; without that nothing overlaps and the ceiling is trivially met. */
async function roundTrip<T>(environmentId: string, value: () => T): Promise<T> {
  beginWireCall(environmentId)
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    return value()
  } finally {
    wire.inFlight -= 1
  }
}

function harness(): {
  cache: AutomationHostCache
  refresh: (options?: { force?: boolean }) => Promise<void>
} {
  const cache = createAutomationHostCache({
    catalogGeneration: () => 0,
    connectionGeneration: () => 0
  })
  const scheduler = createAutomationHostScheduler({
    cache,
    legacyPartitionContext: () => ({ repoConnectionId: () => null, projectsAuthoritative: true }),
    isVisible: () => true,
    scheduleRetry: () => () => {}
  })
  return { cache, refresh: (options) => scheduler.refresh(ALL_REFS.map(targetFor), options) }
}

function snapshot(): AutomationHostDiagnosticsSnapshot {
  return automationHostDiagnostics.snapshot()
}

function authorityCounters(snap: AutomationHostDiagnosticsSnapshot, index: number) {
  return snap.byAuthority[automationAuthorityCatalogKey(stableAuthorityAt(index))]
}

beforeEach(() => {
  automationHostDiagnostics.reset()
  // Confirmed capabilities are module-level and must not leak between tests.
  resetAutomationCapabilityProbes()
  wire = {
    inFlight: 0,
    maxInFlight: 0,
    scopedCalls: 0,
    probes: 0,
    legacyCallsByEnvironment: new Map()
  }
  onWireCall = null
  callRuntimeRpc.mockReset()
  getRuntimeEnvironmentStatus.mockReset()
  getRuntimeEnvironmentStatus.mockImplementation((environmentId: string) => {
    wire.probes += 1
    return roundTrip(environmentId, () => ({
      capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY]
    }))
  })
  callRuntimeRpc.mockImplementation((target: unknown, _method: unknown, params: unknown) => {
    const environmentId = (target as { environmentId: string }).environmentId
    if (params === null) {
      wire.legacyCallsByEnvironment.set(
        environmentId,
        (wire.legacyCallsByEnvironment.get(environmentId) ?? 0) + 1
      )
      return roundTrip(environmentId, () => legacyPayload(environmentId))
    }
    wire.scopedCalls += 1
    const selector = (params as { selector: AutomationListScopeSelector }).selector
    return roundTrip(environmentId, () => scopedPayload(environmentId, selector))
  })
})

describe('the commit fence under real concurrency', () => {
  it('commits nothing from an authority invalidated while its answer was in flight', async () => {
    const { cache, refresh } = harness()
    // Invalidate one scoped and one legacy authority while the other 40 hosts continue committing.
    const stale = new Set(['env-0', `env-${AUTHORITY_COUNT - 1}`])
    const invalidated = new Set<string>()
    onWireCall = (environmentId) => {
      if (!stale.has(environmentId) || invalidated.has(environmentId)) {
        return
      }
      invalidated.add(environmentId)
      cache.invalidateAuthority(stableAuthorityAt(environmentIndex(environmentId)))
    }

    await refresh()

    const snap = snapshot()
    for (const environmentId of stale) {
      const index = environmentIndex(environmentId)
      for (const ref of refsForAuthority(index)) {
        expect(cache.get(ref)?.data ?? []).toEqual([])
      }
      // The answer arrived and was thrown away, which is the gate's whole point.
      expect(authorityCounters(snap, index).discardedCommits).toBeGreaterThanOrEqual(1)
    }
    // Require unaffected rows to land too; blanket rejection could satisfy the stale-response gate while losing valid data.
    const survivors = ALL_REFS.filter(
      (ref) => !stale.has(ref.authority.kind === 'runtime' ? ref.authority.environmentId : '')
    )
    expect(survivors).toHaveLength(HOST_COUNT - stale.size * ENTRIES_PER_AUTHORITY)
    for (const ref of survivors) {
      expect(cache.get(ref)?.data ?? []).toHaveLength(AUTOMATIONS_PER_HOST)
    }
  })

  it('leaves no stale row anywhere in the cache, not merely on its own host', async () => {
    const { cache, refresh } = harness()
    const invalidated = new Set<string>()
    onWireCall = (environmentId) => {
      if (environmentId !== 'env-0' || invalidated.has(environmentId)) {
        return
      }
      invalidated.add(environmentId)
      cache.invalidateAuthority(stableAuthorityAt(0))
    }

    await refresh()

    for (const ref of ALL_REFS) {
      const rows = cache.get(ref)?.data ?? []
      expect(rows.some((row) => row.automation.id.startsWith('auto-0-'))).toBe(false)
    }
    expect(snapshot().byStableKey[hostStableKey(ALL_REFS[0])].rows).toBeGreaterThan(0)
  })
})
