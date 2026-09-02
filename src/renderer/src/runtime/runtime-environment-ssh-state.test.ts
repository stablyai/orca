import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from '../../../shared/ssh-types'
import { useAppStore } from '@/store'
import {
  applyRuntimeEnvironmentSshStateChanged,
  connectRuntimeEnvironmentSshTarget,
  hydrateRuntimeEnvironmentSshState,
  refreshRuntimeEnvironmentSshTargetMetadata,
  resyncRuntimeEnvironmentSshTargets
} from './runtime-environment-ssh-state'
import { callRuntimeRpc } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: vi.fn()
}))

const callRuntimeRpcMock = vi.mocked(callRuntimeRpc)

function connState(
  targetId: string,
  status: SshConnectionState['status'] = 'connected'
): SshConnectionState {
  return {
    targetId,
    status,
    error: null,
    reconnectAttempt: 0,
    providerEpoch: `${targetId}-provider-epoch` as SshProviderEpoch,
    connectionGeneration: 7
  }
}

type RpcResponses = {
  targets?: { id: string; label: string }[]
  labels?: Record<string, string>
  states?: Record<string, SshConnectionState | null>
  failListTargets?: boolean
  failRemovedLabels?: boolean
}

function installRpcResponses(responses: RpcResponses): void {
  callRuntimeRpcMock.mockImplementation((_target, method, params) => {
    switch (method) {
      case 'ssh.listTargetSummaries':
        if (responses.failListTargets) {
          return Promise.reject(new Error('method not found'))
        }
        return Promise.resolve({ targets: responses.targets ?? [] } as never)
      case 'ssh.listRemovedTargetLabels':
        if (responses.failRemovedLabels) {
          return Promise.reject(new Error('method not found'))
        }
        return Promise.resolve({ labels: responses.labels ?? {} } as never)
      case 'ssh.getState': {
        const targetId = (params as { targetId: string }).targetId
        return Promise.resolve({ state: responses.states?.[targetId] ?? null } as never)
      }
      default:
        return Promise.reject(new Error(`unexpected method ${method}`))
    }
  })
}

let envCounter = 0
function nextEnvId(): string {
  envCounter += 1
  return `env-${envCounter}`
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  callRuntimeRpcMock.mockReset()
})

describe('hydrateRuntimeEnvironmentSshState', () => {
  it('populates the environment bucket with targets, tombstones, and per-target states', async () => {
    const envId = nextEnvId()
    installRpcResponses({
      targets: [
        { id: 'ssh-1', label: 'devbox' },
        { id: 'ssh-2', label: 'buildbox' }
      ],
      labels: { 'ssh-old': 'retired box' },
      states: { 'ssh-1': connState('ssh-1', 'connected') }
    })

    await hydrateRuntimeEnvironmentSshState(envId)

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetsHydrated).toBe(true)
    expect(bucket?.targetLabels.get('ssh-1')).toBe('devbox')
    expect(bucket?.removedTargetLabels.get('ssh-old')).toBe('retired box')
    expect(bucket?.connectionStates.get('ssh-1')?.status).toBe('connected')
    expect(bucket?.connectionStates.get('ssh-1')).toMatchObject({
      providerEpoch: 'ssh-1-provider-epoch',
      connectionGeneration: 7
    })
    // ssh-2 had no live state: absent, so reads fall back to 'disconnected'.
    expect(bucket?.connectionStates.has('ssh-2')).toBe(false)
    // Local maps stay untouched.
    expect(useAppStore.getState().sshTargetLabels.size).toBe(0)
    expect(useAppStore.getState().sshTargetsHydrated).toBe(false)
    // Every call was routed to the owning environment.
    for (const [target] of callRuntimeRpcMock.mock.calls) {
      expect(target).toEqual({ kind: 'environment', environmentId: envId })
    }
  })

  it('skips refetching when already hydrated unless forced', async () => {
    const envId = nextEnvId()
    installRpcResponses({ targets: [] })
    await hydrateRuntimeEnvironmentSshState(envId)
    const callsAfterFirst = callRuntimeRpcMock.mock.calls.length

    await hydrateRuntimeEnvironmentSshState(envId)
    expect(callRuntimeRpcMock.mock.calls.length).toBe(callsAfterFirst)

    await hydrateRuntimeEnvironmentSshState(envId, { force: true })
    expect(callRuntimeRpcMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('does not rerun when an ordinary refresh joins a forced hydration', async () => {
    const envId = nextEnvId()
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-1', label: 'devbox' }])
    let resolveTargets!: (value: { targets: { id: string; label: string }[] }) => void
    const targetsPromise = new Promise<{ targets: { id: string; label: string }[] }>((resolve) => {
      resolveTargets = resolve
    })
    callRuntimeRpcMock.mockImplementation((_target, method) => {
      if (method === 'ssh.listTargetSummaries') {
        return targetsPromise as never
      }
      if (method === 'ssh.listRemovedTargetLabels') {
        return Promise.resolve({ labels: {} } as never)
      }
      return Promise.resolve({ state: connState('ssh-1') } as never)
    })

    const forced = hydrateRuntimeEnvironmentSshState(envId, { force: true })
    const ordinary = hydrateRuntimeEnvironmentSshState(envId)
    resolveTargets({ targets: [{ id: 'ssh-1', label: 'devbox' }] })
    await Promise.all([forced, ordinary])

    expect(
      callRuntimeRpcMock.mock.calls.filter(([, method]) => method === 'ssh.listTargetSummaries')
    ).toHaveLength(1)
    expect(
      callRuntimeRpcMock.mock.calls.filter(([, method]) => method === 'ssh.listRemovedTargetLabels')
    ).toHaveLength(1)
    expect(
      callRuntimeRpcMock.mock.calls.filter(([, method]) => method === 'ssh.getState')
    ).toHaveLength(1)
  })

  it('hydrates without force after the environment bucket is marked stale', async () => {
    const envId = nextEnvId()
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-old', label: 'old box' }])
    useAppStore.getState().markEnvironmentSshStateStale(envId)
    installRpcResponses({
      targets: [{ id: 'ssh-new', label: 'new box' }],
      states: { 'ssh-new': connState('ssh-new') }
    })

    await hydrateRuntimeEnvironmentSshState(envId)

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetsHydrated).toBe(true)
    expect(bucket?.targetLabels.get('ssh-new')).toBe('new box')
    expect(bucket?.connectionStates.get('ssh-new')?.status).toBe('connected')
  })

  it('refreshes only target summaries when hydrated metadata is unchanged', async () => {
    const envId = nextEnvId()
    installRpcResponses({
      targets: [{ id: 'ssh-1', label: 'devbox' }],
      states: { 'ssh-1': connState('ssh-1') }
    })
    await hydrateRuntimeEnvironmentSshState(envId)
    callRuntimeRpcMock.mockClear()

    await refreshRuntimeEnvironmentSshTargetMetadata(envId)

    expect(callRuntimeRpcMock.mock.calls.map(([, method]) => method)).toEqual([
      'ssh.listTargetSummaries'
    ])
  })

  it('reads state for a labelled target the bucket never recorded a state for', async () => {
    const envId = nextEnvId()
    // A failed-connect resync can label a target without ever reading its state.
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-new', label: 'new box' }])
    installRpcResponses({
      targets: [{ id: 'ssh-new', label: 'new box' }],
      states: { 'ssh-new': connState('ssh-new') }
    })

    await refreshRuntimeEnvironmentSshTargetMetadata(envId)

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.connectionStates.get('ssh-new')?.status).toBe('connected')
  })

  it('prunes removed targets and fetches state only for newly discovered targets', async () => {
    const envId = nextEnvId()
    useAppStore.getState().setEnvironmentSshTargetsMetadata(envId, [
      { id: 'ssh-keep', label: 'keep' },
      { id: 'ssh-old', label: 'old' }
    ])
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState(envId, 'ssh-keep', connState('ssh-keep'))
    useAppStore.getState().setEnvironmentSshConnectionState(envId, 'ssh-old', connState('ssh-old'))
    installRpcResponses({
      targets: [
        { id: 'ssh-keep', label: 'keep' },
        { id: 'ssh-new', label: 'new' }
      ],
      labels: { 'ssh-old': 'old' },
      states: { 'ssh-new': connState('ssh-new', 'connecting') }
    })

    await refreshRuntimeEnvironmentSshTargetMetadata(envId)

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetLabels.has('ssh-old')).toBe(false)
    expect(bucket?.connectionStates.has('ssh-old')).toBe(false)
    expect(bucket?.removedTargetLabels.get('ssh-old')).toBe('old')
    expect(bucket?.connectionStates.get('ssh-keep')?.status).toBe('connected')
    expect(bucket?.connectionStates.get('ssh-new')?.status).toBe('connecting')
    expect(callRuntimeRpcMock.mock.calls.filter(([, method]) => method === 'ssh.getState')).toEqual(
      [
        [
          { kind: 'environment', environmentId: envId },
          'ssh.getState',
          { targetId: 'ssh-new' },
          expect.anything()
        ]
      ]
    )
  })

  it('reruns hydration when a new generation joins an older in-flight request', async () => {
    const envId = nextEnvId()
    let resolveOlderTargets!: (value: { targets: { id: string; label: string }[] }) => void
    const olderTargets = new Promise<{ targets: { id: string; label: string }[] }>((resolve) => {
      resolveOlderTargets = resolve
    })
    let targetListCallCount = 0
    callRuntimeRpcMock.mockImplementation((_target, method, params) => {
      if (method === 'ssh.listTargetSummaries') {
        targetListCallCount += 1
        return (
          targetListCallCount === 1
            ? olderTargets
            : Promise.resolve({ targets: [{ id: 'ssh-new', label: 'new' }] })
        ) as never
      }
      if (method === 'ssh.listRemovedTargetLabels') {
        return Promise.resolve({ labels: {} } as never)
      }
      const targetId = (params as { targetId: string }).targetId
      return Promise.resolve({ state: connState(targetId) } as never)
    })

    const olderHydration = hydrateRuntimeEnvironmentSshState(envId)
    useAppStore.getState().markEnvironmentSshStateStale(envId)
    const newerHydration = hydrateRuntimeEnvironmentSshState(envId)
    resolveOlderTargets({ targets: [{ id: 'ssh-old', label: 'old' }] })
    await Promise.all([olderHydration, newerHydration])

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(targetListCallCount).toBe(2)
    expect(bucket?.targetsHydrated).toBe(true)
    expect(bucket?.targetLabels.has('ssh-old')).toBe(false)
    expect(bucket?.targetLabels.get('ssh-new')).toBe('new')
    expect(bucket?.connectionStates.get('ssh-new')?.status).toBe('connected')
  })

  it('keeps a failed full refresh full when a metadata refresh queued behind it', async () => {
    const envId = nextEnvId()
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-1', label: 'devbox' }])
    useAppStore.getState().markEnvironmentSshStateStale(envId)
    let rejectFirstTargets!: (error: Error) => void
    const firstTargets = new Promise<never>((_resolve, reject) => {
      rejectFirstTargets = reject
    })
    let targetListCallCount = 0
    callRuntimeRpcMock.mockImplementation((_target, method) => {
      if (method === 'ssh.listTargetSummaries') {
        targetListCallCount += 1
        return (
          targetListCallCount === 1
            ? firstTargets
            : Promise.resolve({ targets: [{ id: 'ssh-1', label: 'devbox' }] })
        ) as never
      }
      if (method === 'ssh.listRemovedTargetLabels') {
        return Promise.resolve({ labels: {} } as never)
      }
      return Promise.resolve({ state: connState('ssh-1') } as never)
    })

    const forced = hydrateRuntimeEnvironmentSshState(envId, { force: true })
    const metadata = refreshRuntimeEnvironmentSshTargetMetadata(envId)
    rejectFirstTargets(new Error('transient target-list failure'))
    await Promise.all([forced, metadata])

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(targetListCallCount).toBe(2)
    expect(bucket?.targetsHydrated).toBe(true)
    expect(bucket?.connectionStates.get('ssh-1')?.status).toBe('connected')
    expect(callRuntimeRpcMock.mock.calls.map(([, method]) => method)).toEqual([
      'ssh.listTargetSummaries',
      'ssh.listTargetSummaries',
      'ssh.listRemovedTargetLabels',
      'ssh.getState'
    ])
  })

  it('leaves the bucket un-hydrated when the host lacks the ssh RPC methods', async () => {
    const envId = nextEnvId()
    installRpcResponses({ failListTargets: true })

    await expect(hydrateRuntimeEnvironmentSshState(envId)).rejects.toThrow()

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetsHydrated ?? false).toBe(false)
  })

  it('still hydrates the target list when the removed-labels fetch fails', async () => {
    const envId = nextEnvId()
    installRpcResponses({
      targets: [{ id: 'ssh-1', label: 'devbox' }],
      failRemovedLabels: true
    })

    await hydrateRuntimeEnvironmentSshState(envId)

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetsHydrated).toBe(true)
    expect(bucket?.targetLabels.get('ssh-1')).toBe('devbox')
  })

  it('does not let an in-flight response resurrect readiness after disconnect', async () => {
    const envId = nextEnvId()
    let resolveTargets!: (value: { targets: { id: string; label: string }[] }) => void
    const targetsPromise = new Promise<{ targets: { id: string; label: string }[] }>((resolve) => {
      resolveTargets = resolve
    })
    callRuntimeRpcMock.mockImplementation((_target, method) => {
      if (method === 'ssh.listTargetSummaries') {
        return targetsPromise as never
      }
      if (method === 'ssh.listRemovedTargetLabels') {
        return Promise.resolve({ labels: {} } as never)
      }
      return Promise.resolve({ state: connState('ssh-1') } as never)
    })

    const hydration = hydrateRuntimeEnvironmentSshState(envId)
    useAppStore.getState().markEnvironmentSshStateStale(envId)
    resolveTargets({ targets: [{ id: 'ssh-1', label: 'devbox' }] })
    await hydration

    expect(useAppStore.getState().sshStateByEnvironment.has(envId)).toBe(false)
  })

  it('does not recreate a removed environment bucket from an in-flight response', async () => {
    const envId = nextEnvId()
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-old', label: 'old box' }])
    let resolveTargets!: (value: { targets: { id: string; label: string }[] }) => void
    const targetsPromise = new Promise<{ targets: { id: string; label: string }[] }>((resolve) => {
      resolveTargets = resolve
    })
    callRuntimeRpcMock.mockImplementation((_target, method) => {
      if (method === 'ssh.listTargetSummaries') {
        return targetsPromise as never
      }
      if (method === 'ssh.listRemovedTargetLabels') {
        return Promise.resolve({ labels: {} } as never)
      }
      return Promise.resolve({ state: connState('ssh-new') } as never)
    })

    const hydration = hydrateRuntimeEnvironmentSshState(envId, { force: true })
    useAppStore.getState().removeEnvironmentSshState(envId)
    resolveTargets({ targets: [{ id: 'ssh-new', label: 'new box' }] })
    await hydration

    expect(useAppStore.getState().sshStateByEnvironment.has(envId)).toBe(false)
  })

  it('prunes connection state for targets removed by an authoritative refresh', async () => {
    const envId = nextEnvId()
    useAppStore.getState().setEnvironmentSshTargetsMetadata(envId, [
      { id: 'ssh-live', label: 'live box' },
      { id: 'ssh-removed', label: 'retired box' }
    ])
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState(envId, 'ssh-live', connState('ssh-live'))
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState(envId, 'ssh-removed', connState('ssh-removed'))
    installRpcResponses({
      targets: [{ id: 'ssh-live', label: 'live box' }],
      states: { 'ssh-live': connState('ssh-live') }
    })

    await hydrateRuntimeEnvironmentSshState(envId, { force: true })

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetLabels.has('ssh-removed')).toBe(false)
    expect(bucket?.connectionStates.has('ssh-removed')).toBe(false)
    expect(bucket?.connectionStates.get('ssh-live')?.status).toBe('connected')
  })
})

describe('applyRuntimeEnvironmentSshStateChanged', () => {
  it('applies a known target state directly into the owning bucket without RPC', () => {
    const envId = nextEnvId()
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-1', label: 'devbox' }])

    applyRuntimeEnvironmentSshStateChanged(envId, 'ssh-1', connState('ssh-1', 'disconnected'))

    expect(
      useAppStore.getState().sshStateByEnvironment.get(envId)?.connectionStates.get('ssh-1')
    ).toMatchObject({
      status: 'disconnected',
      providerEpoch: 'ssh-1-provider-epoch',
      connectionGeneration: 7
    })
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
    // Local map untouched.
    expect(useAppStore.getState().sshConnectionStates.size).toBe(0)
  })

  it('rejects partial authority before retaining a runtime-owned state', () => {
    const envId = nextEnvId()
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-1', label: 'devbox' }])

    applyRuntimeEnvironmentSshStateChanged(envId, 'ssh-1', {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'partial-provider-epoch' as SshProviderEpoch
    })

    expect(
      useAppStore.getState().sshStateByEnvironment.get(envId)?.connectionStates.has('ssh-1')
    ).toBe(false)
  })

  it('does not touch another environment bucket or local state (no cross-pollution)', () => {
    const envA = nextEnvId()
    const envB = nextEnvId()
    useAppStore.getState().setEnvironmentSshTargetsMetadata(envA, [{ id: 'ssh-1', label: 'a' }])
    useAppStore.getState().setEnvironmentSshTargetsMetadata(envB, [{ id: 'ssh-1', label: 'b' }])
    const bucketBBefore = useAppStore.getState().sshStateByEnvironment.get(envB)
    const localStatesBefore = useAppStore.getState().sshConnectionStates

    applyRuntimeEnvironmentSshStateChanged(envA, 'ssh-1', connState('ssh-1', 'connected'))

    const state = useAppStore.getState()
    expect(state.sshStateByEnvironment.get(envA)?.connectionStates.get('ssh-1')?.status).toBe(
      'connected'
    )
    expect(state.sshStateByEnvironment.get(envB)).toBe(bucketBBefore)
    expect(state.sshStateByEnvironment.get(envB)?.connectionStates.size).toBe(0)
    expect(state.sshConnectionStates).toBe(localStatesBefore)
    expect(state.sshConnectionStates.size).toBe(0)
  })

  it('re-fetches the authoritative target list for an unknown target instead of trusting the event', async () => {
    const envId = nextEnvId()
    // The event races a removal: the authoritative list does not contain it.
    installRpcResponses({ targets: [], labels: { 'ssh-gone': 'old devbox' } })

    applyRuntimeEnvironmentSshStateChanged(envId, 'ssh-gone', connState('ssh-gone', 'disconnected'))
    await vi.waitFor(() => {
      expect(useAppStore.getState().sshStateByEnvironment.get(envId)?.targetsHydrated).toBe(true)
    })

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    // The trailing event must not resurrect the removed target's state.
    expect(bucket?.connectionStates.has('ssh-gone')).toBe(false)
    expect(bucket?.removedTargetLabels.get('ssh-gone')).toBe('old devbox')
  })

  it('picks up a just-added target through the forced refresh', async () => {
    const envId = nextEnvId()
    installRpcResponses({
      targets: [{ id: 'ssh-new', label: 'fresh box' }],
      states: { 'ssh-new': connState('ssh-new', 'connecting') }
    })

    applyRuntimeEnvironmentSshStateChanged(envId, 'ssh-new', connState('ssh-new', 'connecting'))
    await vi.waitFor(() => {
      expect(
        useAppStore.getState().sshStateByEnvironment.get(envId)?.targetLabels.get('ssh-new')
      ).toBe('fresh box')
    })

    expect(
      useAppStore.getState().sshStateByEnvironment.get(envId)?.connectionStates.get('ssh-new')
        ?.status
    ).toBe('connecting')
  })
})

describe('connectRuntimeEnvironmentSshTarget', () => {
  it('routes ssh.connect to the owning environment and mirrors the returned state', async () => {
    const envId = nextEnvId()
    callRuntimeRpcMock.mockResolvedValue({ state: connState('ssh-1', 'connected') } as never)

    const state = await connectRuntimeEnvironmentSshTarget(envId, 'ssh-1')

    expect(state?.status).toBe('connected')
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: envId },
      'ssh.connect',
      { targetId: 'ssh-1' },
      expect.anything()
    )
    expect(
      useAppStore.getState().sshStateByEnvironment.get(envId)?.connectionStates.get('ssh-1')?.status
    ).toBe('connected')
    expect(
      useAppStore.getState().sshStateByEnvironment.get(envId)?.connectionStates.get('ssh-1')
    ).toMatchObject({
      providerEpoch: 'ssh-1-provider-epoch',
      connectionGeneration: 7
    })
    expect(useAppStore.getState().sshConnectionStates.size).toBe(0)
  })

  it('propagates connect failures without writing any state', async () => {
    const envId = nextEnvId()
    callRuntimeRpcMock.mockRejectedValue(new Error('SSH target not found'))

    await expect(connectRuntimeEnvironmentSshTarget(envId, 'ssh-dead')).rejects.toThrow(
      'SSH target not found'
    )
    expect(useAppStore.getState().sshStateByEnvironment.has(envId)).toBe(false)
  })
})

describe('resyncRuntimeEnvironmentSshTargets', () => {
  it('applies the target list even when the removed-labels refresh fails', async () => {
    const envId = nextEnvId()
    installRpcResponses({
      targets: [{ id: 'ssh-live', label: 'devbox' }],
      failRemovedLabels: true
    })

    await resyncRuntimeEnvironmentSshTargets(envId)

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetLabels.get('ssh-live')).toBe('devbox')
    expect(bucket?.targetsHydrated).toBe(true)
  })

  it('reads the connection state of a host re-added under a new target id', async () => {
    const envId = nextEnvId()
    useAppStore
      .getState()
      .setEnvironmentSshTargetsMetadata(envId, [{ id: 'ssh-old', label: 'devbox' }])
    installRpcResponses({
      targets: [{ id: 'ssh-new', label: 'devbox' }],
      labels: { 'ssh-old': 'devbox' },
      states: { 'ssh-new': connState('ssh-new') }
    })

    await resyncRuntimeEnvironmentSshTargets(envId)

    const bucket = useAppStore.getState().sshStateByEnvironment.get(envId)
    expect(bucket?.targetLabels.get('ssh-new')).toBe('devbox')
    expect(bucket?.connectionStates.get('ssh-new')?.status).toBe('connected')
  })
})
