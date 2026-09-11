import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeEnvironmentStatus } from '../store/slices/runtime-status-types'
import {
  clearPublishedRuntimeHostStatusReaderForTests,
  clearRuntimeCompatibilityCache,
  clearRuntimeCompatibilityCacheForTests,
  registerPublishedRuntimeHostStatusReader,
  runtimeEnvironmentSupportsCapability
} from './runtime-capability-cache'
import { resolveStructuredChatHostVerdict } from './structured-chat-host-verdict'

const CAPABILITY = STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
const ENV = 'env-a'

const runtimeEnvironmentCall = vi.fn()
const published = new Map<string, RuntimeEnvironmentStatus>()

function runtimeStatus(capabilities: string[], runtimeId = 'rt-1'): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities
  } as unknown as RuntimeStatus
}

function publish(patch: Partial<RuntimeHostStatusSnapshot> = {}): RuntimeEnvironmentStatus {
  const snapshot: RuntimeHostStatusSnapshot = {
    environmentId: ENV,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: Date.now(),
    transport: 'ready',
    verification: 'verified',
    status: runtimeStatus([CAPABILITY]),
    ...patch
  }
  const entry: RuntimeEnvironmentStatus = {
    snapshot,
    status: snapshot.status,
    checkedAt: snapshot.checkedAt
  }
  published.set(snapshot.environmentId, entry)
  return entry
}

/** Warms the module's own cache with a positive verdict, the way any earlier RPC would. */
async function primeCachedPositive(): Promise<void> {
  runtimeEnvironmentCall.mockResolvedValueOnce({
    id: 'status',
    ok: true,
    result: runtimeStatus([CAPABILITY])
  })
  await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(true)
  expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  runtimeEnvironmentCall.mockClear()
}

beforeEach(() => {
  published.clear()
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  // Any probe a test did not queue is an RPC the snapshot should have answered.
  runtimeEnvironmentCall.mockRejectedValue(new Error('unexpected status.get'))
  registerPublishedRuntimeHostStatusReader(() => published)
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: runtimeEnvironmentCall } }
  })
})

afterEach(() => {
  clearPublishedRuntimeHostStatusReaderForTests()
})

describe('the published snapshot is the one capability oracle', () => {
  it('refuses a capability the snapshot does not list, without asking the host', async () => {
    await primeCachedPositive()
    const entry = publish({ sequence: 2, status: runtimeStatus([]) })

    await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(false)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    // The gate reading the same entry synchronously must reach the same verdict.
    expect(
      resolveStructuredChatHostVerdict({ entry, capability: CAPABILITY, admission: undefined })
    ).toBe('host-refuses-capability')
  })

  it('answers a listed capability from the snapshot, without asking the host', async () => {
    publish()
    await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(true)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('offers a capability the snapshot lists even while the cache holds a refusal', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'status',
      ok: true,
      result: runtimeStatus([])
    })
    await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(false)
    runtimeEnvironmentCall.mockClear()

    publish({ sequence: 2 })
    await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(true)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('probes when no snapshot has been published for the host', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'status',
      ok: true,
      result: runtimeStatus([CAPABILITY])
    })
    await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  })

  it('probes again after a re-pair drops the snapshot and the cache', async () => {
    publish({ status: runtimeStatus([]) })
    await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(false)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()

    // A re-pair deletes the status map entry and clears the compatibility cache together.
    published.delete(ENV)
    clearRuntimeCompatibilityCache(ENV)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'status',
      ok: true,
      result: runtimeStatus([CAPABILITY], 'rt-2')
    })
    await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).resolves.toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  })
})

describe('an unanswerable snapshot is not a refusal', () => {
  const unanswerable: [string, Partial<RuntimeHostStatusSnapshot>][] = [
    ['a host this client disconnected', { retired: true, verification: 'blocked' }],
    [
      'a host blocked by version or auth skew',
      { verification: 'blocked', blockedCode: 'unauthorized' }
    ],
    ['a probe still in flight', { verification: 'checking' }],
    ['an answer older than the prober TTL', { checkedAt: Date.now() - 60_001 }]
  ]

  it.each(unanswerable)(
    '%s still throws from the probe rather than answering false',
    async (_label, patch) => {
      publish(patch)
      runtimeEnvironmentCall.mockRejectedValueOnce(new Error('host unreachable'))
      await expect(runtimeEnvironmentSupportsCapability(ENV, CAPABILITY)).rejects.toThrow(
        'host unreachable'
      )
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    }
  )
})
