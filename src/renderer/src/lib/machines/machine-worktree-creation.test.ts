import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineRecord } from '../../../../shared/machine-inventory'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const PROVIDER = 'plugin:omarchy/omarchy' as const

type StoreFixture = {
  repos: { id: string; path: string }[]
  projects: { id: string; displayName: string }[]
  projectHostSetups: {
    id: string
    projectId: string
    hostId: string
    repoId: string
    setupState: string
  }[]
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  activePendingCreationId: string
  updatePendingWorktreeCreation: ReturnType<typeof vi.fn>
  setRuntimeEnvironments: ReturnType<typeof vi.fn>
  setupProjectClone: ReturnType<typeof vi.fn>
  sshConnectionStates: Map<string, unknown>
  applyEnvironmentMachine: ReturnType<typeof vi.fn>
}

const store: StoreFixture = {
  repos: [],
  projects: [{ id: 'project-1', displayName: 'acme-web' }],
  projectHostSetups: [],
  pendingWorktreeCreations: {},
  activePendingCreationId: 'creation-1',
  updatePendingWorktreeCreation: vi.fn(),
  setRuntimeEnvironments: vi.fn(),
  setupProjectClone: vi.fn(),
  sshConnectionStates: new Map(),
  applyEnvironmentMachine: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('@/lib/project-clone-url-prefill', () => ({
  resolveProjectCloneUrlPrefill: () => 'git@github.com:acme/web.git'
}))

import { prepareMachineRequest } from './machine-worktree-creation'

const machines = {
  get: vi.fn(),
  wake: vi.fn(),
  connect: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  onProgress: vi.fn(() => () => {})
}

function record(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: 'box-1',
    name: 'omarchy-dev',
    lifetime: 'persistent',
    state: 'running',
    createdAt: '2026-10-01T00:00:00.000Z',
    providerKey: PROVIDER,
    lastSeenAt: 0,
    access: {
      kind: 'ssh',
      host: 'omarchy',
      port: 2201,
      user: 'dev',
      projectRoot: '/home/dev/src'
    },
    ...overrides
  }
}

const MACHINE = {
  sourceRepoId: 'repo-local',
  projectId: 'project-1',
  providerKey: PROVIDER,
  machineId: 'box-1',
  machineName: 'omarchy-dev'
}

const REQUEST = {
  repoId: 'repo-local',
  name: 'feature',
  baseBranch: 'main',
  setupDecision: 'inherit',
  agent: null,
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null,
  machine: MACHINE
} satisfies WorktreeCreationRequest

beforeEach(() => {
  vi.clearAllMocks()
  store.sshConnectionStates = new Map()
  store.repos = []
  store.projectHostSetups = []
  store.pendingWorktreeCreations = {
    'creation-1': {
      creationId: 'creation-1',
      phase: 'preparing',
      status: 'creating',
      startedAt: 1,
      indeterminate: true,
      loaderVisible: true,
      request: REQUEST
    }
  }
  machines.connect.mockResolvedValue({
    ok: true,
    value: { kind: 'ssh', sshTargetId: 'machine-abc', environmentId: 'env-1' }
  })
  vi.stubGlobal('window', {
    api: { machines, runtimeEnvironments: { list: vi.fn().mockResolvedValue([]) } }
  })
})

describe('prepareMachineRequest', () => {
  it('wakes a sleeping machine before connecting and clones the project into its root', async () => {
    machines.get
      .mockResolvedValueOnce({ ok: true, value: record({ state: 'sleeping', access: undefined }) })
      .mockResolvedValueOnce({ ok: true, value: record() })
    machines.wake.mockResolvedValue({ ok: true, value: record() })
    store.setupProjectClone.mockResolvedValue({
      project: { id: 'project-1' },
      setup: { id: 'setup-1', projectId: 'project-1', hostId: 'runtime:env-1' },
      repo: { id: 'repo-machine', path: '/home/dev/src/web' }
    })

    const prepared = await prepareMachineRequest('creation-1', REQUEST, MACHINE)

    expect(machines.wake.mock.invocationCallOrder[0]).toBeLessThan(
      machines.connect.mock.invocationCallOrder[0]
    )
    expect(store.setupProjectClone).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        hostId: 'runtime:env-1',
        url: 'git@github.com:acme/web.git',
        destination: '/home/dev/src',
        displayName: 'acme-web'
      },
      { onError: expect.any(Function) }
    )
    expect(prepared).toMatchObject({
      repoId: 'repo-machine',
      baseBranch: undefined,
      workspaceRunContext: {
        hostId: 'runtime:env-1',
        projectHostSetupId: 'setup-1',
        path: '/home/dev/src/web'
      }
    })
  })

  it('uses a running machine as is and reuses the project already set up there', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record() })
    store.projectHostSetups = [
      {
        id: 'setup-1',
        projectId: 'project-1',
        hostId: 'runtime:env-1',
        repoId: 'repo-machine',
        setupState: 'ready'
      }
    ]
    store.repos = [{ id: 'repo-machine', path: '/home/dev/src/web' }]

    const prepared = await prepareMachineRequest('creation-1', REQUEST, MACHINE)

    expect(machines.wake).not.toHaveBeenCalled()
    expect(store.setupProjectClone).not.toHaveBeenCalled()
    expect(prepared?.repoId).toBe('repo-machine')
  })

  it('fails the create on a Gone machine without connecting', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record({ state: 'gone' }) })

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(machines.connect).not.toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenLastCalledWith('creation-1', {
      status: 'error',
      error: 'omarchy-dev is gone.'
    })
  })

  it('shows a plain sentence and keeps the provider’s words for the log', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record({ state: 'sleeping' }) })
    machines.wake.mockResolvedValue({
      ok: false,
      code: 'unavailable',
      message: 'tunnel closed: System SSH port forward failed (exit 255)'
    })

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(machines.wake).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: PROVIDER, machineId: 'box-1' })
    )
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      provisioningLog: 'tunnel closed: System SSH port forward failed (exit 255)\n'
    })
    expect(store.updatePendingWorktreeCreation).toHaveBeenLastCalledWith('creation-1', {
      status: 'error',
      error: 'Couldn’t wake omarchy-dev. The provider ran into a problem.'
    })
  })

  it('fails before cloning when the SSH machine has no Orca server', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record() })
    machines.connect.mockResolvedValue({
      ok: true,
      value: { kind: 'ssh', sshTargetId: 'machine-abc' }
    })
    store.sshConnectionStates = new Map([
      [
        'machine-abc',
        { managedServer: { kind: 'relay', reason: 'orcad_unavailable', detail: 'glibc too old' } }
      ]
    ])

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(store.setupProjectClone).not.toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      provisioningLog: 'glibc too old\n'
    })
    expect(store.updatePendingWorktreeCreation).toHaveBeenLastCalledWith('creation-1', {
      status: 'error',
      error: 'Orca couldn’t start its server on omarchy-dev, which it needs to set up the project.'
    })
  })

  it('reports the clone’s own error in the log instead of a second toast', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record() })
    store.setupProjectClone.mockImplementation(
      async (_args: unknown, options: { onError: (message: string) => void }) => {
        options.onError('Permission denied (publickey)')
        return null
      }
    )

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      provisioningLog: 'Permission denied (publickey)\n'
    })
  })

  it('stops before connecting when dismissed during the wake', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record({ state: 'sleeping' }) })
    machines.wake.mockImplementation(async () => {
      store.pendingWorktreeCreations = {}
      return { ok: true, value: record() }
    })

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(machines.connect).not.toHaveBeenCalled()
  })

  it('stops quietly when the pending create was dismissed mid-start', async () => {
    machines.get.mockResolvedValue({ ok: true, value: record() })
    machines.connect.mockImplementation(async () => {
      store.pendingWorktreeCreations = {}
      return { ok: true, value: { kind: 'ssh', sshTargetId: 'machine-abc' } }
    })

    expect(await prepareMachineRequest('creation-1', REQUEST, MACHINE)).toBeNull()
    expect(store.setupProjectClone).not.toHaveBeenCalled()
  })

  it('wakes a paired server’s machine through that server and keeps the chosen location', async () => {
    rpc.call.mockResolvedValue({ ok: true, value: record() })
    const machine = { ...MACHINE, environmentId: 'env-2' }

    const prepared = await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)

    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-2' },
      'machines.wake',
      { providerKey: PROVIDER, machineId: 'box-1' }
    )
    expect(machines.connect).not.toHaveBeenCalled()
    expect(prepared?.repoId).toBe('repo-local')
    // Why: nothing pushes a paired server's changes, so its returned record lands here at once.
    expect(store.applyEnvironmentMachine).toHaveBeenCalledWith(
      'env-2',
      expect.objectContaining({ id: 'box-1' })
    )
  })

  it('creates the machine once, records it for Retry, then sets up the project', async () => {
    machines.create.mockResolvedValue({ ok: true, value: record({ id: 'box-new' }) })
    machines.get.mockResolvedValue({ ok: true, value: record({ id: 'box-new' }) })
    store.setupProjectClone.mockResolvedValue({
      project: { id: 'project-1' },
      setup: { id: 'setup-1', projectId: 'project-1', hostId: 'runtime:env-1' },
      repo: { id: 'repo-machine', path: '/home/dev/src/web' }
    })
    const create = { operationId: 'op-1', name: 'feature', lifetime: 'temporary' as const }
    const machine = {
      sourceRepoId: 'repo-local',
      projectId: 'project-1',
      providerKey: PROVIDER,
      machineName: 'feature',
      create
    }

    const prepared = await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)

    expect(machines.list).not.toHaveBeenCalled()
    expect(machines.create).toHaveBeenCalledWith({ providerKey: PROVIDER, ...create })
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      request: expect.objectContaining({
        machine: expect.objectContaining({ create: { ...create, attempted: true } })
      })
    })
    expect(prepared?.machine?.machineId).toBe('box-new')
  })

  it('on Retry adopts the machine an earlier attempt made instead of creating another', async () => {
    machines.list.mockResolvedValue({
      ok: true,
      value: {
        machines: [record({ id: 'box-old', creatingOperationId: 'op-1' })],
        pendingCreates: []
      }
    })
    machines.get.mockResolvedValue({ ok: true, value: record({ id: 'box-old' }) })
    const machine = {
      ...MACHINE,
      machineId: undefined,
      create: {
        operationId: 'op-1',
        name: 'feature',
        lifetime: 'persistent' as const,
        attempted: true
      }
    }

    await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)

    expect(machines.create).not.toHaveBeenCalled()
    expect(machines.connect).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'box-old' }))
  })

  it('on Retry refuses to create while the earlier outcome is unknown', async () => {
    const machine = {
      ...MACHINE,
      machineId: undefined,
      create: {
        operationId: 'op-1',
        name: 'feature',
        lifetime: 'persistent' as const,
        attempted: true
      }
    }
    machines.list.mockResolvedValueOnce({
      ok: true,
      value: { machines: [], pendingCreates: [{ operationId: 'op-1' }] }
    })
    expect(await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)).toBeNull()
    machines.list.mockResolvedValueOnce({ ok: false, code: 'timeout', message: 'ssh timed out' })
    expect(await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)).toBeNull()

    expect(machines.create).not.toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenLastCalledWith('creation-1', {
      status: 'error',
      error: 'Couldn’t check whether feature was already created.'
    })
  })

  it('names a taken machine name plainly', async () => {
    machines.create.mockResolvedValue({ ok: false, code: 'conflict', message: 'exists' })
    const machine = {
      ...MACHINE,
      machineId: undefined,
      create: { operationId: 'op-3', name: 'feature', lifetime: 'persistent' as const }
    }

    await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)

    expect(store.updatePendingWorktreeCreation).toHaveBeenLastCalledWith('creation-1', {
      status: 'error',
      error: 'A machine named feature already exists. Pick another name in Advanced.'
    })
  })

  it('stops after a cancel without connecting', async () => {
    machines.create.mockImplementation(async () => {
      store.pendingWorktreeCreations['creation-1'].machineProgress = {
        activity: 'creating',
        canceled: true
      }
      return { ok: true, value: record({ id: 'box-new' }) }
    })
    const machine = {
      ...MACHINE,
      machineId: undefined,
      create: { operationId: 'op-2', name: 'feature', lifetime: 'persistent' as const }
    }

    expect(await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)).toBeNull()
    expect(machines.connect).not.toHaveBeenCalled()
  })

  it('never creates a machine when Retry is canceled while it checks the earlier attempt', async () => {
    machines.list.mockImplementation(async () => {
      store.pendingWorktreeCreations['creation-1'].machineProgress = {
        activity: 'creating',
        canceled: true
      }
      return { ok: true, value: { machines: [], pendingCreates: [] } }
    })
    const machine = {
      ...MACHINE,
      machineId: undefined,
      create: {
        operationId: 'op-1',
        name: 'feature',
        lifetime: 'persistent' as const,
        attempted: true
      }
    }

    expect(await prepareMachineRequest('creation-1', { ...REQUEST, machine }, machine)).toBeNull()
    expect(machines.create).not.toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).not.toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({ status: 'error' })
    )
  })
})
