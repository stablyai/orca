// Zero published snapshots satisfied 0===0 and drained resumes before host evidence, duplicating live agents (STA-5377). Requiring nonzero snapshots instead strands truly empty hosts. Probe the PTY controller to distinguish empty, unpublished-but-live and unverifiable hosts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

// Mock the singleton store import; this suite tests settle receipts without store patches.
vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({ updateAgentStatusState: vi.fn() })),
    subscribe: vi.fn(() => () => {})
  }
}))

import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  getRuntimeEnvironmentRevision,
  replaceRuntimeEnvironmentRevisions
} from './runtime-environment-revision'
import {
  hasHostSessionMirrorHydrated,
  parkUntilHostSessionMirrorHydrates,
  resetHostSessionMirrorHydrationForTests
} from './host-session-mirror-hydration'
import { clearHostLiveTerminalProbesForTests } from './host-live-terminal-probe'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import { clearWebSessionTabsTrackingForEnvironment } from './web-session-tabs-sync/tracking-lifecycle'
import type { HostSessionMirrorSettle } from './web-session-tabs-sync/mirror-settle'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const WORKTREE = 'repo1::/path/wt1'

type HostCall = {
  method: string
  params: Record<string, unknown>
  expectedEnvironmentPairingRevision?: number
}

/** `null` models a failed probe: `unverifiable`, never `the host has none`. */
function stubPairedHost(
  liveTerminalHandles: readonly string[] | null,
  omittedHostIds: readonly string[] = []
): HostCall[] {
  const calls: HostCall[] = []
  const call = vi.fn(async (args: { method: string; params: Record<string, unknown> }) => {
    calls.push({ method: args.method, params: args.params })
    if (liveTerminalHandles === null) {
      return { ok: false, error: { code: -32000, message: 'terminal_liveness_unavailable' } }
    }
    return {
      ok: true,
      result: {
        terminals: liveTerminalHandles.map((handle) => ({
          handle,
          worktreeId: WORKTREE,
          connected: true
        })),
        totalCount: liveTerminalHandles.length,
        truncated: false,
        hostScope: { hostIds: ['runtime:env'], omittedHostIds }
      }
    }
  })
  stubRuntimeEnvironmentBridge({ call })
  return calls
}

/** The exact verdict both `listAll` sites build when the host publishes nothing. */
function settleEmptyInventory(
  environmentId: string,
  options: {
    authoritative?: boolean
    expectedEnvironmentConnectionGeneration?: number
    expectedEnvironmentPairingRevision?: number
    expectedTrackingGeneration?: number
  } = {}
): void {
  createEmptyInventorySettle(environmentId, options)()
}

function createEmptyInventorySettle(
  environmentId: string,
  options: {
    authoritative?: boolean
    expectedEnvironmentConnectionGeneration?: number
    expectedEnvironmentPairingRevision?: number
    expectedTrackingGeneration?: number
  } = {}
): HostSessionMirrorSettle {
  return applyWebSessionTabsStorePatch(() => ({}), {
    frames: [],
    fullInventory: { environmentId, publishedSnapshotCount: 0, ...options }
  })
}

async function flushProbe(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('empty host inventory settling the session mirror', () => {
  beforeEach(() => {
    resetHostSessionMirrorHydrationForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    clearHostLiveTerminalProbesForTests()
    replaceRuntimeEnvironmentRevisions([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('leaves waiters parked when the host is live but has not published', async () => {
    const environmentId = 'env-live-unpublished'
    const calls = stubPairedHost(['terminal-1'])
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    settleEmptyInventory(environmentId)
    await flushProbe()

    expect(resumeSweeps).toBe(0)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(false)
    expect(calls.map((entry) => entry.method)).toEqual(['terminal.list'])
    // A stale PTY record would answer an empty list for a live daemon.
    expect(calls[0]?.params.requireFreshPtyLiveness).toBe(true)
  })

  it('settles a host that genuinely owns no terminals', async () => {
    const environmentId = 'env-no-terminals'
    stubPairedHost([])
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    settleEmptyInventory(environmentId)
    await flushProbe()

    expect(resumeSweeps).toBe(1)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(true)
  })

  it('does not let a probe response cross a same-id pairing revision', async () => {
    const environmentId = 'env-repaired'
    let resolveProbe!: (response: RuntimeRpcResponse<unknown>) => void
    const call = vi.fn(
      () =>
        new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
          resolveProbe = resolve
        })
    )
    stubRuntimeEnvironmentBridge({ call })
    replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 1, pairingRevision: 11 }])
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    settleEmptyInventory(environmentId, { expectedEnvironmentPairingRevision: 11 })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEnvironmentPairingRevision: 11 })
    )
    replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 1, pairingRevision: 12 }])
    expect(getRuntimeEnvironmentRevision(environmentId)).toBe(12)
    resolveProbe({
      id: 'probe-repaired',
      ok: true,
      result: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['runtime:env'], omittedHostIds: [] }
      },
      _meta: { runtimeId: 'runtime' }
    })
    await flushProbe()

    expect(resumeSweeps).toBe(0)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(false)
  })

  it('does not reuse an in-flight probe across same-id pairing revisions', async () => {
    const environmentId = 'env-repaired-inflight'
    const responses: ((response: RuntimeRpcResponse<unknown>) => void)[] = []
    const call = vi.fn(
      () =>
        new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
          responses.push(resolve)
        })
    )
    stubRuntimeEnvironmentBridge({ call })
    replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 1, pairingRevision: 11 }])
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    settleEmptyInventory(environmentId, { expectedEnvironmentPairingRevision: 11 })
    replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 1, pairingRevision: 12 }])
    settleEmptyInventory(environmentId, { expectedEnvironmentPairingRevision: 12 })
    expect(call).toHaveBeenCalledTimes(2)

    responses[0]!({
      id: 'probe-old-owner',
      ok: true,
      result: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['runtime:old'], omittedHostIds: [] }
      },
      _meta: { runtimeId: 'runtime-old' }
    })
    responses[1]!({
      id: 'probe-new-owner',
      ok: true,
      result: {
        terminals: [{ handle: 'terminal-new-owner' }],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['runtime:new'], omittedHostIds: [] }
      },
      _meta: { runtimeId: 'runtime-new' }
    })
    await flushProbe()

    expect(resumeSweeps).toBe(0)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(false)
  })

  it('invalidates a pending legacy probe when environment tracking is cleared', async () => {
    const environmentId = 'env-cleared'
    let resolveProbe!: (response: RuntimeRpcResponse<unknown>) => void
    const call = vi.fn(
      () =>
        new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
          resolveProbe = resolve
        })
    )
    stubRuntimeEnvironmentBridge({ call })
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    settleEmptyInventory(environmentId)
    clearWebSessionTabsTrackingForEnvironment(environmentId)
    resolveProbe({
      id: 'probe-cleared',
      ok: true,
      result: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['runtime:env'], omittedHostIds: [] }
      },
      _meta: { runtimeId: 'runtime' }
    })
    await flushProbe()

    expect(resumeSweeps).toBe(0)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(false)
  })
})
