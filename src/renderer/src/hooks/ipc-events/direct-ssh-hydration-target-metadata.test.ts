import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from '@/store/slices/runtime-environment-ssh'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { registerDirectSshStateIpcBridge } from './direct-ssh-state-ipc-bridge'
import type { DirectSshBridgeRuntime } from './direct-ssh-bridge-runtime'

type SshApiStub = {
  listTargets: () => Promise<{ id: string; label: string }[]>
  listRemovedTargetLabels: () => Promise<Record<string, string>>
  getState: (args: { targetId: string }) => Promise<SshConnectionState | null>
}

function connectingState(targetId: string): SshConnectionState {
  return { targetId, status: 'connecting', error: null, reconnectAttempt: 0 }
}

let onStateChangedHandler: ((data: { targetId: string; state: unknown }) => void) | null = null

function stubWindow(ssh: SshApiStub): void {
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    api: {
      ui: {},
      ssh: {
        ...ssh,
        listPortForwards: () => Promise.resolve([]),
        listDetectedPorts: () => Promise.resolve([]),
        onCredentialRequest: () => () => {},
        onCredentialResolved: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onStateChanged: (handler: (data: { targetId: string; state: unknown }) => void) => {
          onStateChangedHandler = handler
          return () => {}
        }
      }
    }
  })
}

function bridgeRuntime(): DirectSshBridgeRuntime {
  return {
    reconnectAuthorityByTarget: new Map(),
    reconnectCoordinator: {
      requestReconnect: vi.fn(async () => ({ status: 'complete' })),
      replaceAuthority: vi.fn(),
      correctUnboundTerminals: vi.fn(() => 0),
      invalidate: vi.fn()
    },
    currentAuthority: () => null,
    terminalActions: () => ({}),
    prepareAndSync: vi.fn(async () => {}),
    isStopped: () => false,
    addDeadline: vi.fn(),
    removeDeadline: vi.fn(),
    stop: vi.fn()
  } as unknown as DirectSshBridgeRuntime
}

/** Lets pending IPC promises settle without leaning on a wall-clock delay. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
  }
}

describe('direct SSH hydration target metadata', () => {
  const unsubs: (() => void)[] = []

  beforeEach(() => {
    onStateChangedHandler = null
    useAppStore.setState({
      sshTargetLabels: new Map(),
      removedSshTargetLabels: new Map(),
      sshTargetsHydrated: false,
      sshConnectionStates: new Map()
    })
  })

  afterEach(() => {
    for (const unsub of unsubs.splice(0)) {
      unsub()
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('names a ghost host once its tombstone label lands', async () => {
    let resolveRemovedLabels!: (labels: Record<string, string>) => void
    stubWindow({
      listTargets: () => Promise.resolve([{ id: 'ssh-live', label: 'devbox' }]),
      listRemovedTargetLabels: () =>
        new Promise((resolve) => {
          resolveRemovedLabels = resolve
        }),
      getState: () => Promise.resolve(null)
    })

    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    await settle()

    resolveRemovedLabels({ 'ssh-ghost': 'old devbox' })
    await settle()

    const settled = useAppStore.getState()
    expect({
      removed: selectRuntimeAwareSshTargetRemoved(settled, null, 'ssh-ghost'),
      label: selectRuntimeAwareSshTargetLabel(settled, null, 'ssh-ghost')
    }).toEqual({ removed: true, label: 'old devbox' })
  })

  it('lands live target labels while the removed-labels round trip is still in flight', async () => {
    let listTargetsCalls = 0
    stubWindow({
      listTargets: () => {
        listTargetsCalls += 1
        return Promise.resolve([{ id: 'ssh-live', label: 'devbox' }])
      },
      listRemovedTargetLabels: () => new Promise(() => {}),
      getState: () => Promise.resolve(connectingState('ssh-live'))
    })

    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    await settle()

    expect({
      label: selectRuntimeAwareSshTargetLabel(useAppStore.getState(), null, 'ssh-live'),
      status: useAppStore.getState().sshConnectionStates.get('ssh-live')?.status
    }).toEqual({ label: 'devbox', status: 'connecting' })

    // A push for a known target takes the fast path instead of re-querying the
    // link that is already failing to answer.
    listTargetsCalls = 0
    onStateChangedHandler?.({ targetId: 'ssh-live', state: connectingState('ssh-live') })
    await settle()
    expect({
      listTargetsCalls,
      status: useAppStore.getState().sshConnectionStates.get('ssh-live')?.status
    }).toEqual({ listTargetsCalls: 0, status: 'connecting' })
  })

  it('keeps the target list and records the failure when removed labels are unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubWindow({
      listTargets: () => Promise.resolve([{ id: 'ssh-live', label: 'devbox' }]),
      listRemovedTargetLabels: () => Promise.reject(new Error('method not found')),
      getState: () => Promise.resolve(null)
    })

    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    await settle()

    // Older paired hosts lack the RPC; the target list is the evidence that matters and must survive.
    expect(useAppStore.getState().sshTargetLabels.get('ssh-live')).toBe('devbox')
    expect(useAppStore.getState().sshTargetsHydrated).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  it('hydrates later targets when one target state lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubWindow({
      listTargets: () =>
        Promise.resolve([
          { id: 'ssh-unreachable', label: 'unreachable' },
          { id: 'ssh-second', label: 'second' }
        ]),
      listRemovedTargetLabels: () => Promise.resolve({}),
      getState: ({ targetId }) =>
        targetId === 'ssh-unreachable'
          ? Promise.reject(new Error('ssh state lookup timed out'))
          : Promise.resolve(connectingState(targetId))
    })

    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    await settle()

    const state = useAppStore.getState()
    expect(state.sshConnectionStates.get('ssh-second')?.status).toBe('connecting')
    // A lookup that threw observes nothing: no synthesized state for the unreachable target.
    expect(state.sshConnectionStates.has('ssh-unreachable')).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('hydrates the target list without waiting on the removed-labels round trip', async () => {
    stubWindow({
      listTargets: () => Promise.resolve([{ id: 'ssh-live', label: 'devbox' }]),
      // A wedged relay never answers the tombstone RPC; the loaded list is still evidence.
      listRemovedTargetLabels: () => new Promise(() => {}),
      getState: () => Promise.resolve(null)
    })

    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    await settle()

    expect({
      label: useAppStore.getState().sshTargetLabels.get('ssh-live'),
      hydrated: useAppStore.getState().sshTargetsHydrated
    }).toEqual({ label: 'devbox', hydrated: true })
  })

  it('does not clobber a target that landed while removed labels were in flight', async () => {
    let resolveRemovedLabels!: (labels: Record<string, string>) => void
    let listTargetsCalls = 0
    stubWindow({
      listTargets: () => {
        listTargetsCalls += 1
        return Promise.resolve(
          listTargetsCalls === 1
            ? [{ id: 'ssh-alpha', label: 'alpha' }]
            : [
                { id: 'ssh-alpha', label: 'alpha' },
                { id: 'ssh-bravo', label: 'bravo' }
              ]
        )
      },
      listRemovedTargetLabels: () =>
        new Promise((resolve) => {
          resolveRemovedLabels = resolve
        }),
      getState: () => Promise.resolve(null)
    })

    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    await settle()

    // A target added during the tombstone round trip pushes state and re-queries the list.
    onStateChangedHandler?.({ targetId: 'ssh-bravo', state: connectingState('ssh-bravo') })
    await settle()

    resolveRemovedLabels({})
    await settle()

    const state = useAppStore.getState()
    expect({
      label: state.sshTargetLabels.get('ssh-bravo'),
      hydrated: state.sshTargetsHydrated,
      removed: selectRuntimeAwareSshTargetRemoved(state, null, 'ssh-bravo')
    }).toEqual({ label: 'bravo', hydrated: true, removed: false })
  })
})
