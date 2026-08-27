import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  startRuntimeStatusRecoveryProbe,
  type RuntimeStatusRecoveryPort
} from './runtime-status-recovery-probe'
import { RUNTIME_PROTOCOL_VERSION } from '../../../shared/protocol-version'
import type { RuntimeStatusRefreshOutcome } from '@/store/slices/runtime-status-refresh'

/**
 * The recovered-host feedback loop end to end: a request the host answers has to
 * reach the recovery probe, because `runtimeStatusByEnvironmentId` is otherwise
 * written only by explicit probes and a failed boot probe outlives the outage (#16516).
 */
const runtimeEnvironmentCall = vi.fn()
const refreshRuntimeEnvironmentStatus = vi.fn(() =>
  Promise.resolve<RuntimeStatusRefreshOutcome>('reachable')
)
const disconnectedHosts = new Set<string>()
let stop: (() => void) | null = null

const port: RuntimeStatusRecoveryPort = {
  isRuntimeEnvironmentDisconnected: (environmentId) => disconnectedHosts.has(environmentId),
  listDisconnectedRuntimeEnvironmentIds: () => [...disconnectedHosts],
  refreshRuntimeEnvironmentStatus: async (environmentId) => {
    const outcome = await refreshRuntimeEnvironmentStatus()
    if (outcome === 'reachable') {
      disconnectedHosts.delete(environmentId)
    }
    return outcome
  },
  subscribeToRecordedStatusChanges: () => () => {}
}

function respondOk(result: unknown): void {
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'remote',
    ok: true,
    result,
    _meta: { runtimeId: 'honey-mac-runtime' }
  })
}

const compatibleStatus = {
  runtimeId: 'honey-mac-runtime',
  graphStatus: 'ready',
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleClientProtocolVersion: RUNTIME_PROTOCOL_VERSION
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  refreshRuntimeEnvironmentStatus.mockReset()
  disconnectedHosts.clear()
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: vi.fn(() => Promise.resolve({ id: 'local', ok: true, result: compatibleStatus }))
      },
      runtimeEnvironments: { call: runtimeEnvironmentCall, subscribe: vi.fn() }
    }
  })
  stop = startRuntimeStatusRecoveryProbe(port)
})

afterEach(() => {
  stop?.()
  stop = null
  vi.unstubAllGlobals()
})

describe('runtime status recovery from answered requests', () => {
  it('re-probes a host recorded as unreachable once it answers a request', async () => {
    disconnectedHosts.add('honey-mac')
    respondOk(compatibleStatus)

    await callRuntimeRpc({ kind: 'environment', environmentId: 'honey-mac' }, 'status.get')

    expect(refreshRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
  })

  it('does not re-probe once per request after the probe itself failed', async () => {
    // Why: `callRuntimeRpc` notes every answered environment request, so a host that keeps
    // answering while its `status.get` fails would otherwise be probed at RPC frequency.
    disconnectedHosts.add('honey-mac')
    refreshRuntimeEnvironmentStatus.mockResolvedValue('unreachable')
    respondOk(compatibleStatus)

    for (let index = 0; index < 20; index += 1) {
      await callRuntimeRpc({ kind: 'environment', environmentId: 'honey-mac' }, 'status.get')
    }

    expect(refreshRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
  })

  it('leaves a host with a known status alone', async () => {
    // Why: mirroring and terminals answer constantly; only a stuck `null` entry
    // is worth the round trip.
    respondOk(compatibleStatus)

    await callRuntimeRpc({ kind: 'environment', environmentId: 'honey-mac' }, 'status.get')

    expect(refreshRuntimeEnvironmentStatus).not.toHaveBeenCalled()
  })

  it('does not re-probe when the request never reached the host', async () => {
    // A transport failure is not evidence either way — the recorded verdict stands
    // until the backoff sweep asks again (docs/reference/ssh-execution-boundary.md).
    disconnectedHosts.add('honey-mac')
    runtimeEnvironmentCall.mockRejectedValue(new Error('socket closed'))

    await expect(
      callRuntimeRpc({ kind: 'environment', environmentId: 'honey-mac' }, 'status.get')
    ).rejects.toThrow('socket closed')

    expect(refreshRuntimeEnvironmentStatus).not.toHaveBeenCalled()
  })

  it('ignores local runtime calls', async () => {
    disconnectedHosts.add('honey-mac')

    await callRuntimeRpc({ kind: 'local' }, 'status.get')

    expect(refreshRuntimeEnvironmentStatus).not.toHaveBeenCalled()
  })
})
