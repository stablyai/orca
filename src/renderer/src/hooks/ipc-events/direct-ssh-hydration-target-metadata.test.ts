import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { selectRuntimeAwareSshTargetRemoved } from '@/store/slices/ssh/runtime-environment-ssh-selectors'
import { registerDirectSshStateIpcBridge } from './direct-ssh-state-ipc-bridge'
import { resetSshConfigPassiveSyncForTests } from '../../runtime/hosts/ssh/ssh-config-passive-sync'
import type { SshConnectionState } from '../../../../shared/ssh-types'

type SshApiStub = {
  importConfig?: () => Promise<{
    targets: { id: string; label: string }[]
    repoReadoptions: never[]
  }>
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
        listUnrestoredPortForwards: () => Promise.resolve([]),
        listDetectedPorts: () => Promise.resolve([]),
        onCredentialRequest: () => () => {},
        onCredentialResolved: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onTargetRemoved: () => () => {},
        onStateChanged: (handler: (data: { targetId: string; state: unknown }) => void) => {
          onStateChangedHandler = handler
          return () => {}
        }
      }
    }
  })
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
    resetSshConfigPassiveSyncForTests()
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

  it('keeps the target list and records the failure when removed labels are unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubWindow({
      listTargets: () => Promise.resolve([{ id: 'ssh-live', label: 'devbox' }]),
      listRemovedTargetLabels: () => Promise.reject(new Error('method not found')),
      getState: () => Promise.resolve(null)
    })

    unsubs.push(registerDirectSshStateIpcBridge(unsubs))
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

    unsubs.push(registerDirectSshStateIpcBridge(unsubs))
    await settle()

    const state = useAppStore.getState()
    expect(state.sshConnectionStates.get('ssh-second')?.status).toBe('connecting')
    // A lookup that threw observes nothing: no synthesized state for the unreachable target.
    expect(state.sshConnectionStates.has('ssh-unreachable')).toBe(false)
    expect(warn).toHaveBeenCalled()
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

    unsubs.push(registerDirectSshStateIpcBridge(unsubs))
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
