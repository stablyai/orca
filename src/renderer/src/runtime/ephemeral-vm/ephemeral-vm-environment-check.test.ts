import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Entry = {
  environmentCheck?: {
    status: string
    checks?: { id: string }[]
    sleepsAt?: number
    finishedAt?: number
    sandbox?: string
  }
}

const { callRuntimeRpc, supportsCapability, store } = vi.hoisted(() => {
  const entries: Record<string, Entry> = {}
  return {
    callRuntimeRpc: vi.fn(),
    supportsCapability: vi.fn(async () => true),
    store: {
      entries,
      getState: () => ({
        pendingWorktreeCreations: entries,
        activePendingCreationId: 'c1',
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

import {
  BLOCKED_SANDBOX_SLEEP_MS,
  gateVmCreateOnEnvironmentCheck,
  type CloudEnvironmentCheckContext
} from './ephemeral-vm-environment-check'
import {
  cancelVmEnvironmentCheck,
  resolveVmEnvironmentCheckDecision
} from './ephemeral-vm-environment-check-decision'
import {
  getCloudSetupNoticesRecord,
  resetCloudSetupNotices
} from '@/lib/orca-cloud/cloud-setup-notices-store'

const failing = {
  worktreePath: '/w',
  ok: false,
  checks: [{ id: 'tool.pnpm', category: 'tools', status: 'fail', message: 'pnpm missing' }]
}
const passing = { worktreePath: '/w', ok: true, checks: [] }
// What Neil saw: agents not set up, push refused, setup not run. None of it should stop the create.
const cloudWarnings = {
  worktreePath: '/w',
  ok: false,
  checks: [
    { id: 'agent.claude', category: 'agents', status: 'warn', message: 'Claude signed out' },
    { id: 'git.push', category: 'git', status: 'fail', message: 'push refused' },
    { id: 'setup.run', category: 'setup', status: 'warn', message: 'not run', code: 'setupNotRun' }
  ]
}
const cloudFatal = {
  worktreePath: '/w',
  ok: false,
  checks: [
    { id: 'workspace.path', category: 'workspace', status: 'fail', message: 'no repo' },
    { id: 'git.push', category: 'git', status: 'fail', message: 'push refused' }
  ]
}
const CLOUD: CloudEnvironmentCheckContext = {
  runtimeId: 'rt-1',
  setupRunsOnCreate: false,
  repoId: 'repo-1',
  hostId: 'runtime:env-1',
  repoUrl: 'https://github.com/stablyai/orca'
}

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
    resetCloudSetupNotices()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('pauses on failed checks, re-runs them on retry, and continues once they pass', async () => {
    callRuntimeRpc.mockResolvedValueOnce(failing).mockResolvedValueOnce(passing)
    const gate = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')
    await settle()
    expect(store.entries.c1.environmentCheck?.status).toBe('failed')

    resolveVmEnvironmentCheckDecision('c1', 'retry')
    await expect(gate).resolves.toBe('proceed')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(store.entries.c1.environmentCheck?.status).toBe('passed')
  })

  it('continues on Open anyway and stops when the build is dismissed', async () => {
    callRuntimeRpc.mockResolvedValue(failing)
    const opened = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')
    await settle()
    resolveVmEnvironmentCheckDecision('c1', 'open-anyway')
    await expect(opened).resolves.toBe('proceed')

    const dismissed = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')
    await settle()
    delete store.entries.c1
    cancelVmEnvironmentCheck('c1')
    await expect(dismissed).resolves.toBe('stop')
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
    await expect(gate).resolves.toBe('stop')
    expect(signal?.aborted).toBe(true)
  })

  it('skips the checks on a VM server that predates them', async () => {
    supportsCapability.mockResolvedValue(false)
    await expect(gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w')).resolves.toBe('proceed')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(store.entries.c1.environmentCheck?.status).toBe('skipped')
  })

  it('Orca Cloud opens on warnings and a refused push, and hands them to the workspace', async () => {
    callRuntimeRpc.mockResolvedValue(cloudWarnings)
    await expect(gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w', CLOUD)).resolves.toBe(
      'proceed'
    )
    expect(store.entries.c1.environmentCheck?.status).toBe('passed')
    const record = getCloudSetupNoticesRecord('env-1')
    expect(record?.repoUrl).toBe('https://github.com/stablyai/orca')
    // Agent sign-in is never a notice; push and setup are.
    expect(record?.notices.map((notice) => notice.kind)).toEqual(['push', 'setup'])
  })

  it('a failed reach of origin waits for a confirming check before any line shows (ENV-ORIGIN-TOAST)', async () => {
    callRuntimeRpc.mockResolvedValue({
      ...cloudWarnings,
      checks: [
        ...cloudWarnings.checks,
        {
          id: 'git.fetch',
          category: 'git',
          status: 'fail',
          message: 'Cannot reach remote "origin".'
        }
      ]
    })
    const confirm = vi.fn().mockResolvedValue('reachable')
    await expect(gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w', CLOUD, confirm)).resolves.toBe(
      'proceed'
    )
    // The rest show now; the fetch line is the confirmer's to add, never published straight away.
    expect(getCloudSetupNoticesRecord('env-1')?.notices.map((notice) => notice.kind)).toEqual([
      'push',
      'setup'
    ])
    expect(confirm).toHaveBeenCalledOnce()
    const [published, notice] = confirm.mock.calls[0]
    expect(published.notices.map((n: { kind: string }) => n.kind)).toEqual(['push', 'setup'])
    expect(notice.kind).toBe('fetch')
  })

  it('Orca Cloud stops only on a fatal check, lists just it, and can start over', async () => {
    callRuntimeRpc.mockResolvedValue(cloudFatal)
    const gate = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w', CLOUD)
    await settle()
    const check = store.entries.c1.environmentCheck
    expect(check?.status).toBe('failed')
    expect(check?.checks?.map((c) => c.id)).toEqual(['workspace.path'])
    expect(check?.sleepsAt).toBe((check?.finishedAt ?? 0) + BLOCKED_SANDBOX_SLEEP_MS)

    resolveVmEnvironmentCheckDecision('c1', 'restart')
    await expect(gate).resolves.toBe('restart')
  })

  it('puts a blocked sandbox to sleep after five unused minutes', async () => {
    vi.useFakeTimers()
    const suspendRuntime = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { api: { ephemeralVm: { suspendRuntime } } })
    callRuntimeRpc.mockResolvedValue(cloudFatal)
    const gate = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w', CLOUD)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.entries.c1.environmentCheck?.status).toBe('failed')

    await vi.advanceTimersByTimeAsync(BLOCKED_SANDBOX_SLEEP_MS - 1)
    expect(suspendRuntime).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(suspendRuntime).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
    expect(store.entries.c1.environmentCheck?.sandbox).toBe('asleep')

    // Still waiting on the user: Delete or Start again.
    cancelVmEnvironmentCheck('c1')
    await expect(gate).resolves.toBe('stop')
  })

  it('deletes a blocked sandbox that cannot sleep, so it never keeps billing', async () => {
    vi.useFakeTimers()
    const suspendRuntime = vi.fn(async () => ({ ok: false, error: 'nope' }))
    vi.stubGlobal('window', { api: { ephemeralVm: { suspendRuntime } } })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    callRuntimeRpc.mockResolvedValue(cloudFatal)
    const gate = gateVmCreateOnEnvironmentCheck('c1', 'env-1', '/w', CLOUD)
    await vi.advanceTimersByTimeAsync(BLOCKED_SANDBOX_SLEEP_MS)
    await expect(gate).resolves.toBe('stop')
    expect(store.entries.c1.environmentCheck?.sandbox).toBe('deleted')
  })
})
