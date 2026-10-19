import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { registerDirectSshStateIpcBridge } from './direct-ssh-state-ipc-bridge'

function connectingState(targetId: string): SshConnectionState {
  return { targetId, status: 'connecting', error: null, reconnectAttempt: 0 }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve()
  }
}

describe('direct SSH hydration fanout', () => {
  const unsubs: (() => void)[] = []

  beforeEach(() => {
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

  it('does not let one wedged target stall hydration of every target behind it', async () => {
    // More targets than the fanout width: the pool must drain past the wedged one, not just
    // dispatch the first wave.
    const targets = ['ssh-wedged', 'ssh-b', 'ssh-c', 'ssh-d', 'ssh-e', 'ssh-f']
    const dispatched: string[] = []
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
      api: {
        ui: {},
        ssh: {
          listTargets: () => Promise.resolve(targets.map((id) => ({ id, label: id }))),
          listRemovedTargetLabels: () => Promise.resolve({}),
          // A wedged relay answers nothing until the 30s RPC timeout fires.
          getState: ({ targetId }: { targetId: string }) => {
            dispatched.push(targetId)
            return targetId === 'ssh-wedged'
              ? new Promise<SshConnectionState | null>(() => {})
              : Promise.resolve(connectingState(targetId))
          },
          listPortForwards: () => Promise.resolve([]),
          listDetectedPorts: () => Promise.resolve([]),
          onCredentialRequest: () => () => {},
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {},
          onStateChanged: () => () => {}
        }
      }
    })

    unsubs.push(registerDirectSshStateIpcBridge(unsubs))
    await settle()

    const states = useAppStore.getState().sshConnectionStates
    expect({
      dispatched: dispatched.length,
      hydrated: targets.filter((id) => states.has(id))
    }).toEqual({
      dispatched: 6,
      hydrated: ['ssh-b', 'ssh-c', 'ssh-d', 'ssh-e', 'ssh-f']
    })
  })
})
