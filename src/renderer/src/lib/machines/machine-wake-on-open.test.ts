import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineProviderSnapshot, MachineRecord } from '../../../../shared/machine-inventory'
import type { MachineSources } from './machine-host-match'

const PROVIDER = 'plugin:omarchy/omarchy' as const

const mocks = vi.hoisted(() => {
  const state: {
    sources: MachineSources | null
    tabsByWorktree: Record<string, unknown[]>
    machineWakeByWorktreeId: Record<string, unknown>
  } = { sources: null, tabsByWorktree: {}, machineWakeByWorktreeId: {} }
  return {
    state,
    callRuntimeRpc: vi.fn(),
    toastError: vi.fn(),
    toastLoading: vi.fn<(message: string, options?: { id?: string }) => string>(() => 'toast-1'),
    toastDismiss: vi.fn(),
    setWake: vi.fn()
  }
})

vi.mock('@/store/machines', () => ({
  getMachineSources: () => mocks.state.sources,
  applyEnvironmentMachineResult: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      tabsByWorktree: mocks.state.tabsByWorktree,
      machineWakeByWorktreeId: mocks.state.machineWakeByWorktreeId,
      setWorktreeMachineWake: mocks.setWake
    })
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, loading: mocks.toastLoading, dismiss: mocks.toastDismiss }
}))

import { wakeMachineForHost } from './machine-wake-on-open'

function snapshot(machine: Partial<MachineRecord>): MachineProviderSnapshot {
  return {
    providerKey: PROVIDER,
    name: 'Omarchy',
    pendingCreates: [],
    machines: [
      {
        id: 'box-1',
        name: 'omarchy-dev',
        lifetime: 'persistent',
        state: 'sleeping',
        createdAt: '2026-10-01T00:00:00.000Z',
        providerKey: PROVIDER,
        lastSeenAt: 0,
        sshTargetId: 'machine-a',
        ...machine
      }
    ]
  }
}

const machines = { wake: vi.fn(), connect: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  machines.wake.mockResolvedValue({ ok: true, value: {} })
  machines.connect.mockResolvedValue({ ok: true, value: { kind: 'ssh', sshTargetId: 'machine-a' } })
  vi.stubGlobal('window', { api: { machines } })
})

describe('wakeMachineForHost', () => {
  it('wakes and reconnects a sleeping machine, with one toast for repeat opens', async () => {
    mocks.state.sources = { self: [snapshot({})], environments: {} }

    await Promise.all([wakeMachineForHost('ssh:machine-a'), wakeMachineForHost('ssh:machine-a')])

    // Why: main joins the two asks into one provider wake; the renderer just asks.
    expect(machines.wake).toHaveBeenCalledWith({ providerKey: PROVIDER, machineId: 'box-1' })
    const toastIds = new Set(mocks.toastLoading.mock.calls.map((call) => call[1]?.id))
    expect(toastIds.size).toBe(1)
    expect(mocks.toastLoading).toHaveBeenCalledWith('Waking omarchy-dev…', {
      id: expect.stringContaining('box-1')
    })
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('leaves running machines and plain hosts alone', async () => {
    mocks.state.sources = {
      self: [snapshot({ state: 'running' })],
      environments: {}
    }

    await wakeMachineForHost('ssh:machine-a')
    await wakeMachineForHost('ssh:dev-box')

    expect(machines.wake).not.toHaveBeenCalled()
  })

  it('asks a paired server to wake a machine its provider owns', async () => {
    mocks.state.sources = {
      self: [],
      environments: { 'env-2': [snapshot({})] }
    }
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, value: {} })

    await wakeMachineForHost('nested:env-2/machine-a')

    expect(machines.wake).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-2' },
      'machines.wake',
      { providerKey: PROVIDER, machineId: 'box-1' }
    )
  })

  it('reports a failed wake without throwing into navigation', async () => {
    mocks.state.sources = { self: [snapshot({})], environments: {} }
    machines.wake.mockResolvedValue({ ok: false, code: 'unavailable', message: 'host is down' })

    await wakeMachineForHost('ssh:machine-a')

    expect(mocks.toastError).toHaveBeenCalledWith('Couldn’t wake omarchy-dev', {
      id: 'toast-1',
      description: 'The provider ran into a problem.'
    })
    expect(machines.connect).not.toHaveBeenCalled()
  })

  it('reports a wake whose reconnect fails', async () => {
    mocks.state.sources = { self: [snapshot({})], environments: {} }
    machines.connect.mockResolvedValue({ ok: false, code: 'timeout', message: 'ssh exit 255' })

    await wakeMachineForHost('ssh:machine-a')

    expect(mocks.toastError).toHaveBeenCalledWith('Couldn’t wake omarchy-dev', {
      id: 'toast-1',
      description: 'The provider didn’t answer in time.'
    })
  })

  it('marks the worktree until wake and connect settle, so its terminals hold their attach', async () => {
    mocks.state.sources = { self: [snapshot({})], environments: {} }
    mocks.state.tabsByWorktree = { 'wt-1': [{}], 'wt-2': [{}] }
    let resolveConnect: (value: unknown) => void = () => {}
    machines.connect.mockReturnValueOnce(new Promise((resolve) => (resolveConnect = resolve)))

    const opening = wakeMachineForHost('ssh:machine-a', 'wt-1')
    // A second open while it wakes still marks its own worktree.
    const joining = wakeMachineForHost('ssh:machine-a', 'wt-2')
    await vi.waitFor(() => expect(machines.connect).toHaveBeenCalled())

    expect(mocks.toastLoading).not.toHaveBeenCalled()
    expect(mocks.setWake).toHaveBeenCalledWith('wt-1', {
      machineName: 'omarchy-dev',
      hostId: 'ssh:machine-a',
      failure: null
    })
    expect(mocks.setWake).toHaveBeenCalledWith('wt-2', expect.objectContaining({ failure: null }))
    expect(mocks.setWake).not.toHaveBeenCalledWith('wt-1', null)

    resolveConnect({ ok: true, value: { kind: 'ssh', sshTargetId: 'machine-a' } })
    await Promise.all([opening, joining])

    expect(mocks.setWake).toHaveBeenCalledWith('wt-1', null)
    expect(mocks.setWake).toHaveBeenCalledWith('wt-2', null)
    mocks.state.tabsByWorktree = {}
  })

  it('keeps a failed wake on the worktree for its terminals’ Retry, with no second toast', async () => {
    mocks.state.sources = { self: [snapshot({})], environments: {} }
    mocks.state.tabsByWorktree = { 'wt-1': [{}] }
    machines.wake.mockResolvedValue({ ok: false, code: 'timeout', message: 'slow' })

    await wakeMachineForHost('ssh:machine-a', 'wt-1')

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.setWake).toHaveBeenLastCalledWith('wt-1', {
      machineName: 'omarchy-dev',
      hostId: 'ssh:machine-a',
      failure: 'The provider didn’t answer in time.'
    })
    mocks.state.tabsByWorktree = {}
  })

  it('releases held terminals when Retry finds the machine already running', async () => {
    mocks.state.sources = { self: [snapshot({ state: 'running' })], environments: {} }
    mocks.state.machineWakeByWorktreeId = { 'wt-1': {} }

    await wakeMachineForHost('ssh:machine-a', 'wt-1')

    expect(machines.wake).not.toHaveBeenCalled()
    expect(mocks.setWake).toHaveBeenCalledWith('wt-1', null)
    mocks.state.machineWakeByWorktreeId = {}
  })
})
