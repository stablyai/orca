import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import {
  createRuntimeStatusSlice,
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  type RuntimeStatusSlice
} from '../store/slices/runtime-status'
import type { RuntimeEnvironmentStatus } from '../store/slices/runtime-status-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import { RuntimeHostStatusOwner } from '../../../shared/runtime-host-status-owner'
import {
  runtimeHostStatusFailure,
  type RuntimeHostStatusResponse
} from '../../../shared/runtime-host-status'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  resolveStructuredChatHostVerdict,
  isUnknownStructuredChatHostVerdict,
  STRUCTURED_CHAT_HOST_VERDICT_STALE_MS,
  type StructuredChatHostAdmission,
  type StructuredChatHostVerdict
} from './structured-chat-host-verdict'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/runtime/restored-client-hosted-browser-host-attach', () => ({
  ensureBrowserClientHostsForRestoredPages: vi.fn(),
  ensureBrowserClientHostForRestartedRuntime: vi.fn()
}))
vi.mock('@/runtime/client-hosted-browser-close-intent-replay', () => ({
  replayClientHostedBrowserCloseIntents: vi.fn()
}))

const CAPABILITY = STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
const NOW = 1_000_000

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.clearAllMocks()
})

function snapshot(patch: Partial<RuntimeHostStatusSnapshot> = {}): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'env-a',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: NOW,
    transport: 'ready',
    verification: 'verified',
    status: { runtimeId: 'rt-1', capabilities: [CAPABILITY] } as unknown as RuntimeStatus,
    ...patch
  }
}

function entryOf(patch: Partial<RuntimeHostStatusSnapshot> = {}): RuntimeEnvironmentStatus {
  const value = snapshot(patch)
  return { snapshot: value, status: value.status, checkedAt: value.checkedAt }
}

function verdictOf(
  entry: RuntimeEnvironmentStatus | undefined,
  admission: StructuredChatHostAdmission = { enabled: true }
): StructuredChatHostVerdict {
  return resolveStructuredChatHostVerdict({ entry, capability: CAPABILITY, admission, now: NOW })
}

describe('verdict rows', () => {
  const rows: [string, StructuredChatHostVerdict, () => StructuredChatHostVerdict][] = [
    [
      'a probe in flight',
      'unknown-checking',
      () => verdictOf(entryOf({ verification: 'checking' }))
    ],
    ['no map entry at all', 'unknown-no-entry', () => verdictOf(undefined)],
    [
      'an entry that carries no snapshot',
      'unknown-no-entry',
      () => verdictOf({ status: null, checkedAt: NOW })
    ],
    [
      'a host that did not answer',
      'unknown-unavailable',
      () => verdictOf(entryOf({ verification: 'unavailable', status: null }))
    ],
    ['a verified host that admits structured chat', 'supported', () => verdictOf(entryOf())],
    [
      'a verified host that publishes no admission',
      'supported',
      () => verdictOf(entryOf(), undefined)
    ],
    [
      'a verified host whose policy is off',
      'host-policy-disabled',
      () => verdictOf(entryOf(), { enabled: false })
    ],
    [
      'a host that never advertised the capability',
      'host-refuses-capability',
      () =>
        verdictOf(
          entryOf({ status: { runtimeId: 'rt-1', capabilities: [] } as unknown as RuntimeStatus })
        )
    ],
    [
      'a host with no capability list at all',
      'host-refuses-capability',
      () => verdictOf(entryOf({ status: { runtimeId: 'rt-1' } as unknown as RuntimeStatus }))
    ],
    [
      'a retired host',
      'host-disconnected',
      () =>
        verdictOf(entryOf({ retired: true, verification: 'blocked', transport: 'disconnected' }))
    ],
    [
      'a blocked host with a failure code',
      'version-or-auth-skew',
      () => verdictOf(entryOf({ verification: 'blocked', blockedCode: 'unauthorized' }))
    ],
    [
      'an answer older than the prober TTL',
      'unknown-stale',
      () => verdictOf(entryOf({ checkedAt: NOW - STRUCTURED_CHAT_HOST_VERDICT_STALE_MS - 1 }))
    ]
  ]
  it.each(rows)('reads %s as %s', (_label, expected, resolve) => {
    expect(resolve()).toBe(expected)
  })

  it('keeps an answer exactly at the staleness bound usable', () => {
    expect(verdictOf(entryOf({ checkedAt: NOW - STRUCTURED_CHAT_HOST_VERDICT_STALE_MS }))).toBe(
      'supported'
    )
  })

  it('lets retirement outrank a blocked cause recorded before the disconnect', () => {
    expect(
      verdictOf(entryOf({ retired: true, verification: 'blocked', blockedCode: 'unauthorized' }))
    ).toBe('host-disconnected')
  })

  it('never accuses a host of skew when blocked carries no cause', () => {
    expect(verdictOf(entryOf({ verification: 'blocked' }))).toBe('unknown-unavailable')
  })

  it('groups exactly the ask-again verdicts as unknown', () => {
    const verdicts: StructuredChatHostVerdict[] = [
      'unknown-checking',
      'unknown-no-entry',
      'unknown-unavailable',
      'unknown-stale',
      'supported',
      'host-refuses-capability',
      'host-policy-disabled',
      'host-disconnected',
      'version-or-auth-skew'
    ]
    expect(verdicts.filter(isUnknownStructuredChatHostVerdict)).toEqual([
      'unknown-checking',
      'unknown-no-entry',
      'unknown-unavailable',
      'unknown-stale'
    ])
  })
})

const environment = {
  id: 'env-a',
  name: 'Host',
  createdAt: 1,
  pairingRevision: 1,
  endpoints: [],
  preferredEndpointId: ''
} as unknown as PublicKnownRuntimeEnvironment

function store() {
  const value = create<RuntimeStatusSlice>()((...args) =>
    createRuntimeStatusSlice(...(args as unknown as Parameters<typeof createRuntimeStatusSlice>))
  )
  value.getState().setRuntimeEnvironments([environment])
  return value
}

function storeVerdict(viewer: ReturnType<typeof store>): StructuredChatHostVerdict {
  return verdictOf(viewer.getState().runtimeStatusByEnvironmentId.get('env-a'))
}

describe('windows that leave a healthy host without a usable entry', () => {
  it('reads a snapshot dropped by the pairing-revision guard as unknown, not as a refusal', () => {
    const viewer = store()
    viewer.getState().applyRuntimeHostStatusSnapshot(snapshot({ pairingRevision: 2 }))
    expect(viewer.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(storeVerdict(viewer)).toBe('unknown-no-entry')
  })

  it('reads the gap after a re-pair deletes the replaced entry as unknown', () => {
    const viewer = store()
    viewer.getState().applyRuntimeHostStatusSnapshot(snapshot())
    expect(storeVerdict(viewer)).toBe('supported')
    viewer.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
    expect(viewer.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(storeVerdict(viewer)).toBe('unknown-no-entry')
  })

  it('reads an entry published without a snapshot as unknown', () => {
    const viewer = store()
    viewer.getState().setRuntimeEnvironmentStatus('env-a', {
      status: { runtimeId: 'rt-1', capabilities: [CAPABILITY] } as unknown as RuntimeStatus,
      checkedAt: NOW
    })
    expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.snapshot).toBeUndefined()
    expect(storeVerdict(viewer)).toBe('unknown-no-entry')
  })
})

function ownerSnapshot(response: RuntimeHostStatusResponse): {
  owner: RuntimeHostStatusOwner
  read: () => RuntimeHostStatusSnapshot
} {
  const published: RuntimeHostStatusSnapshot[] = []
  const owner = new RuntimeHostStatusOwner({
    environmentId: 'env-a',
    pairingRevision: 1,
    request: () => Promise.resolve(response),
    verified: () => false,
    publish: (value) => published.push(value)
  })
  return { owner, read: () => published.at(-1) as RuntimeHostStatusSnapshot }
}

describe('owner-published snapshots', () => {
  it('tells a disconnect the client caused apart from host version or auth skew', async () => {
    const skewed = ownerSnapshot(
      runtimeHostStatusFailure('protocol_version_mismatch', 'Host is too old.')
    )
    skewed.owner.activate()
    await vi.waitFor(() => expect(skewed.read().verification).toBe('blocked'))
    const skewEntry: RuntimeEnvironmentStatus = {
      snapshot: skewed.read(),
      status: null,
      checkedAt: skewed.read().checkedAt
    }

    const disconnected = ownerSnapshot(runtimeHostStatusFailure('unauthorized', 'Pair again.'))
    disconnected.owner.dispose()
    const disconnectedEntry: RuntimeEnvironmentStatus = {
      snapshot: disconnected.read(),
      status: null,
      checkedAt: disconnected.read().checkedAt
    }
    expect(disconnectedEntry.snapshot?.verification).toBe('blocked')

    expect(verdictOf(skewEntry)).toBe('version-or-auth-skew')
    expect(verdictOf(disconnectedEntry)).toBe('host-disconnected')
    skewed.owner.dispose()
  })
})
