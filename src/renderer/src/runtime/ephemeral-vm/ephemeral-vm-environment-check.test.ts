import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc, supportsCapability, store } = vi.hoisted(() => {
  const entries: Record<string, { environmentCheck?: { status: string } }> = {}
  return {
    callRuntimeRpc: vi.fn(),
    supportsCapability: vi.fn(async () => true),
    store: {
      entries,
      getState: () => ({
        pendingWorktreeCreations: entries,
        updatePendingWorktreeCreation: (id: string, patch: Record<string, unknown>) => {
          if (entries[id]) {
            Object.assign(entries[id], patch)
          }
        }
      })
    }
  }
})

vi.mock('@/store/index', () => ({ useAppStore: { getState: store.getState } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: supportsCapability
}))

import { gateVmCreateOnEnvironmentCheck } from './ephemeral-vm-environment-check'
import {
  cancelVmEnvironmentCheck,
  resolveVmEnvironmentCheckDecision
} from './ephemeral-vm-environment-check-decision'

const failing = {
  worktreePath: '/w',
  ok: false,
  checks: [{ id: 'tool.pnpm', category: 'tools', status: 'fail', message: 'pnpm missing' }]
}
const passing = { worktreePath: '/w', ok: true, checks: [] }

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('gateVmCreateOnEnvironmentCheck', () => {
  beforeEach(() => {
    for (const key of Object.keys(store.entries)) {
      delete store.entries[key]
    }
    store.entries.c1 = {}
    callRuntimeRpc.mockReset()
    supportsCapability.mockResolvedValue(true)
  })

  it('pauses on failed checks, re-runs them on retry, and continues once they pass', async () => {
    callRuntimeRpc.mockResolvedValueOnce(failing).mockResolvedValueOnce(passing)
    const gate = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')
    await settle()
    expect(store.entries.c1.environmentCheck?.status).toBe('failed')

    resolveVmEnvironmentCheckDecision('c1', 'retry')
    await expect(gate).resolves.toBe(true)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(store.entries.c1.environmentCheck?.status).toBe('passed')
  })

  it('continues on Open anyway and stops when the build is dismissed', async () => {
    callRuntimeRpc.mockResolvedValue(failing)
    const opened = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')
    await settle()
    resolveVmEnvironmentCheckDecision('c1', 'open-anyway')
    await expect(opened).resolves.toBe(true)

    const dismissed = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')
    await settle()
    delete store.entries.c1
    cancelVmEnvironmentCheck('c1')
    await expect(dismissed).resolves.toBe(false)
  })

  it('aborts a running check when the build is dismissed', async () => {
    let signal: AbortSignal | undefined
    callRuntimeRpc.mockImplementation(
      (_target, _method, _params, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = options.signal
          options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const gate = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')
    await settle()
    delete store.entries.c1
    cancelVmEnvironmentCheck('c1')
    await expect(gate).resolves.toBe(false)
    expect(signal?.aborted).toBe(true)
  })

  it('skips the checks on a VM server that predates them', async () => {
    supportsCapability.mockResolvedValue(false)
    await expect(gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')).resolves.toBe(true)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(store.entries.c1.environmentCheck?.status).toBe('skipped')
  })
})
