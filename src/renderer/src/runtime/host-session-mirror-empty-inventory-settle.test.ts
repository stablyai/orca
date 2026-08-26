/**
 * STA-5377. An inventory that published zero snapshots satisfied
 * `settles.length === fullInventory.publishedSnapshotCount` as `0 === 0` and
 * fired the environment-wide "the host has spoken" verdict with no host
 * evidence behind it. A live relay/SSH-paired host answers exactly that until
 * its renderer's first mirror publish, so the drained resume sweep forked
 * `codex resume` / `claude --resume` onto a PTY the host was still running.
 *
 * All three states are pinned here because the naive floor
 * (`settles.length > 0`) trades the duplicate session for the opposite defect:
 * a genuinely zero-terminal host whose panes park forever. The distinguisher
 * is host readiness — `terminal.list` reads the PTY controller, not the
 * session-tab mirror — so an empty mirror plus a live PTY is a THIRD state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

// Why: web-session-tabs-sync imports the app-level store singleton, and this
// suite drives only the settle receipt — no store patch is exercised.
vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  hasHostSessionMirrorHydrated,
  parkUntilHostSessionMirrorHydrates,
  resetHostSessionMirrorHydrationForTests
} from './host-session-mirror-hydration'
import {
  clearHostLiveTerminalProbesForTests,
  probeHostLiveTerminals
} from './host-live-terminal-probe'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync'

const WORKTREE = 'repo1::/path/wt1'

type HostCall = { method: string; params: Record<string, unknown> }

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
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
  return calls
}

/** The exact verdict both `listAll` sites build when the host publishes nothing. */
function settleEmptyInventory(environmentId: string): void {
  applyWebSessionTabsStorePatch(() => ({}), {
    frames: [],
    fullInventory: { environmentId, publishedSnapshotCount: 0 }
  })()
}

async function flushProbe(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('empty host inventory settling the session mirror', () => {
  beforeEach(() => {
    resetHostSessionMirrorHydrationForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    clearHostLiveTerminalProbesForTests()
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

  it('leaves waiters parked when the readiness probe fails', async () => {
    const environmentId = 'env-probe-failed'
    stubPairedHost(null)
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    settleEmptyInventory(environmentId)
    await flushProbe()

    expect(resumeSweeps).toBe(0)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(false)
  })

  it('leaves waiters parked when terminal.list omits an execution host', async () => {
    const environmentId = 'env-omitted-host'
    stubPairedHost([], ['ssh:box-1'])
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    settleEmptyInventory(environmentId)
    await flushProbe()

    expect(resumeSweeps).toBe(0)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(false)
  })

  it('accepts a legacy zero-terminal result without host scope', async () => {
    const result = await probeHostLiveTerminals(
      'env-legacy-zero',
      vi.fn(async () => ({
        id: 'legacy-zero',
        ok: true as const,
        result: { terminals: [], totalCount: 0, truncated: false },
        _meta: { runtimeId: 'runtime' }
      }))
    )

    expect(result).toBe('none')
  })

  it('accepts a legacy live result without host scope', async () => {
    const result = await probeHostLiveTerminals(
      'env-legacy-live',
      vi.fn(async () => ({
        id: 'legacy-live',
        ok: true as const,
        result: {
          terminals: [{ handle: 'terminal-1' }],
          totalCount: 1,
          truncated: false
        },
        _meta: { runtimeId: 'runtime' }
      }))
    )

    expect(result).toBe('live')
  })

  it('rejects a present malformed host scope as unverifiable', async () => {
    const result = await probeHostLiveTerminals(
      'env-malformed-scope',
      vi.fn(async () => ({
        id: 'malformed-scope',
        ok: true as const,
        result: {
          terminals: [],
          totalCount: 0,
          truncated: false,
          hostScope: { omittedHostIds: [] }
        },
        _meta: { runtimeId: 'runtime' }
      }))
    )

    expect(result).toBe('unverifiable')
  })

  it('still settles the environment when the inventory published snapshots', async () => {
    const environmentId = 'env-published'
    const calls = stubPairedHost(['terminal-1'])
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(environmentId, WORKTREE, () => {
      resumeSweeps += 1
    })

    applyWebSessionTabsStorePatch(() => ({}), {
      frames: [
        {
          environmentId,
          worktreeId: WORKTREE,
          decision: { apply: true, settlesHostMirror: true } as never
        }
      ],
      fullInventory: { environmentId, publishedSnapshotCount: 1 }
    })()

    // Why: a published inventory is host evidence on its own — it must settle
    // in the same tick as before, with no probe round trip.
    expect(resumeSweeps).toBe(1)
    expect(hasHostSessionMirrorHydrated(environmentId, WORKTREE)).toBe(true)
    await flushProbe()
    expect(calls).toEqual([])
  })

  it('does not reuse an in-flight probe across connection generations', async () => {
    const responses: ((response: RuntimeRpcResponse<unknown>) => void)[] = []
    const call = vi.fn(
      (): Promise<RuntimeRpcResponse<unknown>> =>
        new Promise((resolve) => {
          responses.push(resolve)
        })
    )
    const firstProbe = probeHostLiveTerminals('env-generation', call, 1)
    const secondProbe = probeHostLiveTerminals('env-generation', call, 2)

    expect(call).toHaveBeenCalledTimes(2)
    responses[0]!({
      id: 'probe-1',
      ok: true,
      result: {
        terminals: [{}],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['runtime:env'], omittedHostIds: [] }
      },
      _meta: { runtimeId: 'runtime' }
    })
    responses[1]!({
      id: 'probe-2',
      ok: true,
      result: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['runtime:env'], omittedHostIds: [] }
      },
      _meta: { runtimeId: 'runtime' }
    })

    await expect(firstProbe).resolves.toBe('live')
    await expect(secondProbe).resolves.toBe('none')
  })
})
