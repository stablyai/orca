import { admitSshConnectionState } from '../../../../shared/ssh-retained-payload-admission'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { useAppStore } from '../../store'
import { registerRuntimeOwnedSshStateIpcBridge } from './runtime-owned-ssh-state-ipc-bridge'

const targetId = 'runtime-ssh-orca-vm'
const connected = admitSshConnectionState(
  {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    connectionGeneration: 42,
    providerEpoch: 'epoch'
  },
  targetId
)!

let push: (data: { targetId: string; state: SshConnectionState }) => void
const list = vi.fn()
const getState = vi.fn()
let unsubs: (() => void)[]
beforeEach(() => {
  unsubs = []
  useAppStore.setState({
    runtimeOwnedSshConnectionStates: new Map(),
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map()
  })
  list.mockReset().mockResolvedValue([{ connectionMode: 'ssh', sshTargetId: targetId }])
  getState.mockReset().mockResolvedValue(connected)
  vi.stubGlobal('window', {
    api: {
      ephemeralVm: { listRuntimes: list },
      ssh: {
        getState,
        onStateChanged: (listener: typeof push) => {
          push = listener
          return () => {}
        }
      }
    }
  })
})
afterEach(() => {
  unsubs.forEach((fn) => fn())
  vi.unstubAllGlobals()
})

it('hydrates authority independently of the public SSH host list', async () => {
  registerRuntimeOwnedSshStateIpcBridge(unsubs)
  await vi.waitFor(() =>
    expect(useAppStore.getState().runtimeOwnedSshConnectionStates.get(targetId)).toEqual(connected)
  )
  expect(useAppStore.getState().sshConnectionStates.size).toBe(0)
  expect(useAppStore.getState().sshTargetLabels.size).toBe(0)
  push({ targetId: 'ordinary', state: { ...connected, targetId: 'ordinary' } })
  expect(useAppStore.getState().runtimeOwnedSshConnectionStates.has('ordinary')).toBe(false)
})
it('does not overwrite a disconnect with a late initial snapshot', async () => {
  let resolve: (state: SshConnectionState) => void = () => {
    throw new Error('not pending')
  }
  getState.mockImplementation(
    () =>
      new Promise<SshConnectionState>((done) => {
        resolve = done
      })
  )
  registerRuntimeOwnedSshStateIpcBridge(unsubs)
  await vi.waitFor(() => expect(getState).toHaveBeenCalledOnce())
  const disconnected = { ...connected, status: 'disconnected' as const, connectionGeneration: 43 }
  push({ targetId, state: disconnected })
  resolve(connected)
  await new Promise((done) => setTimeout(done, 0))
  expect(useAppStore.getState().runtimeOwnedSshConnectionStates.get(targetId)).toEqual(disconnected)
})
it('does not hydrate paired runtime targets or mutate after disposal', async () => {
  list.mockResolvedValue([
    { connectionMode: 'ssh', sshTargetId: targetId, runtimeEnvironmentId: 'server' }
  ])
  registerRuntimeOwnedSshStateIpcBridge(unsubs)
  await new Promise((done) => setTimeout(done, 0))
  expect(getState).not.toHaveBeenCalled()
  unsubs.forEach((fn) => fn())
  push({ targetId, state: connected })
  expect(useAppStore.getState().runtimeOwnedSshConnectionStates.size).toBe(0)
})
it('removes stale authority when the main process has no session', async () => {
  useAppStore.getState().setRuntimeOwnedSshConnectionState(targetId, connected)
  getState.mockResolvedValue(null)
  registerRuntimeOwnedSshStateIpcBridge(unsubs)
  await vi.waitFor(() =>
    expect(useAppStore.getState().runtimeOwnedSshConnectionStates.has(targetId)).toBe(false)
  )
})
