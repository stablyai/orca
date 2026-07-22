import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { useAppStore } from '@/store'
import {
  applyRuntimeEnvironmentSshStateChanged,
  connectRuntimeEnvironmentSshTarget,
  hydrateRuntimeEnvironmentSshState,
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
  return { targetId, status, error: null, reconnectAttempt: 0 }
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
      useAppStore.getState().sshStateByEnvironment.get(envId)?.connectionStates.get('ssh-1')?.status
    ).toBe('disconnected')
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
    // Local map untouched.
    expect(useAppStore.getState().sshConnectionStates.size).toBe(0)
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
})
