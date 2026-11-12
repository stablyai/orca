import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from '../../../../../shared/ssh-types'
import { useAppStore } from '@/store/index'
import {
  applyRuntimeEnvironmentSshStateChanged,
  hydrateRuntimeEnvironmentSshState,
  refreshRuntimeEnvironmentSshTargetMetadata
} from './runtime-environment-ssh-state'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'

vi.mock('../../rpc/calls/runtime-rpc-call', async (importOriginal) => ({
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

    expect(bucket?.targetsHydrated).toBe(true)
    expect(bucket?.connectionStates.get('ssh-1')?.status).toBe('connected')
  })
})

describe('applyRuntimeEnvironmentSshStateChanged', () => {
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
})
