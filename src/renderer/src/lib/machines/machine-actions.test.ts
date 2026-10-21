import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineRecord } from '../../../../shared/machine-inventory'
import type { MachineMatch } from './machine-host-match'

type MockState = {
  repos: { id: string }[]
  worktreesByRepo: Record<string, unknown[]>
  tabsByWorktree: Record<string, unknown[]>
  runtimePaneTitlesByTabId: Record<string, unknown>
  ptyIdsByTabId: Record<string, unknown>
  applyEnvironmentMachine: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const state: MockState = {
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    applyEnvironmentMachine: vi.fn()
  }
  const rpc = vi.fn()
  const working = vi.fn((): Record<string, { agents: unknown[] }> => ({}))
  return { toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() }, state, working, rpc }
})
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/agent-status', () => ({ getWorkingAgentsPerWorktree: mocks.working }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

import {
  buildMachineSshCommand,
  getMachineMenuActionLabel,
  getMachineMenuActions,
  runMachineMenuAction
} from './machine-actions'

const machines = { sleep: vi.fn(), wake: vi.fn(), archive: vi.fn(), list: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { machines } })
})

function match(machine: Partial<MachineRecord>, environmentId: string | null = null): MachineMatch {
  return {
    environmentId,
    snapshot: {
      providerKey: 'plugin:p/o',
      name: 'Omarchy',
      machines: [],
      pendingCreates: [],
      capabilities: {
        verbs: ['create', 'sleep', 'wake', 'archive', 'delete', 'get'],
        lifetimes: ['persistent']
      }
    },
    machine: {
      id: 'm',
      name: 'box',
      lifetime: 'persistent',
      state: 'running',
      createdAt: '2026-10-19T08:00:00.000Z',
      providerKey: 'plugin:p/o',
      lastSeenAt: 0,
      ...machine
    }
  }
}

const ACCESS = {
  kind: 'ssh' as const,
  host: '100.84.183.82',
  port: 42200,
  user: 'dev',
  projectRoot: '/home/dev/work',
  jumpHost: 'omarchy'
}

describe('getMachineMenuActions', () => {
  it('offers only what applies to each state', () => {
    expect(getMachineMenuActions(match({ access: ACCESS }))).toEqual([
      'sleep',
      'archive',
      'copy-ssh',
      'refresh',
      'delete'
    ])
    expect(getMachineMenuActions(match({ state: 'sleeping' }))).toEqual([
      'wake',
      'archive',
      'refresh',
      'delete'
    ])
    expect(getMachineMenuActions(match({ state: 'archived' }))).toEqual([
      'wake',
      'refresh',
      'delete'
    ])
    expect(getMachineMenuActions(match({ state: 'unreachable' }))).toEqual(['refresh'])
    // Mid-create or mid-wake, the provider is still acting on it.
    expect(getMachineMenuActions(match({ state: 'waking' }))).not.toContain('delete')
    // Mid-sleep: no Wake, Sleep or Delete until it settles.
    expect(getMachineMenuActions(match({ state: 'stopping' }))).toEqual(['refresh'])
  })

  it('keeps archive, delete and the SSH command off machines a paired server owns', () => {
    expect(getMachineMenuActions(match({ access: ACCESS }, 'env-1'))).toEqual(['sleep'])
  })

  it('lets a machine in error be deleted, and names Refresh as Retry there', () => {
    const errored = match({ state: 'error' })
    expect(getMachineMenuActions(errored)).toEqual(['refresh', 'delete'])
    expect(getMachineMenuActionLabel('refresh', errored)).toBe('Retry')
  })

  it('offers nothing verb-backed when the provider declared no capabilities', () => {
    const bare = match({ state: 'sleeping' })
    expect(
      getMachineMenuActions({ ...bare, snapshot: { ...bare.snapshot, capabilities: undefined } })
    ).toEqual(['refresh'])
  })
})

describe('runMachineMenuAction', () => {
  it('says another action is running when the provider reports a conflict', async () => {
    machines.archive.mockResolvedValue({ ok: false, code: 'conflict', message: 'busy' })
    await runMachineMenuAction('archive', match({}))
    expect(mocks.toast.error).toHaveBeenCalledWith('Couldn’t archive box', {
      description: 'Another action is running on box.'
    })
  })

  it('asks before sleeping a machine with working agents', async () => {
    mocks.state.repos = [{ id: 'r' }]
    mocks.state.worktreesByRepo = { r: [{ id: 'wt', repoId: 'r', hostId: 'ssh:t-1' }] }
    mocks.working.mockReturnValueOnce({ wt: { agents: [{}, {}] } })
    await runMachineMenuAction('sleep', match({ sshTargetId: 't-1' }))
    expect(machines.sleep).not.toHaveBeenCalled()
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      '2 agents are working on box',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Sleep anyway' }) })
    )
  })

  it('counts agents on a paired server’s machine before sleeping it', async () => {
    mocks.state.repos = [{ id: 'r' }]
    mocks.state.worktreesByRepo = { r: [{ id: 'wt', repoId: 'r', hostId: 'nested:env-1/t-1' }] }
    mocks.working.mockReturnValueOnce({ wt: { agents: [{}] } })
    await runMachineMenuAction('sleep', match({ sshTargetId: 't-1' }, 'env-1'))
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.toast.warning).toHaveBeenCalledWith('1 agent is working on box', expect.anything())
  })

  it('takes the record a paired server returns after Sleep', async () => {
    mocks.state.worktreesByRepo = {}
    const slept = { ...match({}).machine, state: 'sleeping' }
    mocks.rpc.mockResolvedValue({ ok: true, value: slept })
    await runMachineMenuAction('sleep', match({}, 'env-1'))
    expect(mocks.state.applyEnvironmentMachine).toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({ id: 'm', state: 'sleeping' })
    )
  })

  it('reports a refresh that failed', async () => {
    machines.list.mockResolvedValue({ ok: false, code: 'timeout', message: 'slow' })
    await runMachineMenuAction('refresh', match({}))
    expect(mocks.toast.error).toHaveBeenCalledWith('Couldn’t refresh Omarchy', {
      description: 'The provider didn’t answer in time.'
    })
  })
})

describe('buildMachineSshCommand', () => {
  it('builds a pasteable ssh command, or none without access', () => {
    expect(buildMachineSshCommand(ACCESS)).toBe('ssh -J omarchy -p 42200 dev@100.84.183.82')
    expect(buildMachineSshCommand(undefined)).toBeNull()
  })
})
