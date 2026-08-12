import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from '../../../shared/ssh-types'
import { useAppStore } from '@/store'
import {
  applyEphemeralVmSshState,
  clearEphemeralVmSshAuthority,
  hydrateEphemeralVmSshAuthority
} from './ephemeral-vm-ssh-authority'

const RUNTIME_TARGET_ID = 'runtime-ssh-1'
const OTHER_RUNTIME_TARGET_ID = 'runtime-ssh-2'
const USER_TARGET_ID = 'ssh-user-1'

const getStateMock = vi.fn()
const connectMock = vi.fn()

function connectionState(
  targetId: string,
  overrides: Partial<SshConnectionState> = {}
): SshConnectionState {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    providerEpoch: `${targetId}-epoch` as SshProviderEpoch,
    connectionGeneration: 1,
    ...overrides
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  getStateMock.mockReset()
  connectMock.mockReset()
  vi.stubGlobal('window', {
    api: {
      ssh: {
        getState: getStateMock,
        connect: connectMock
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applyEphemeralVmSshState', () => {
  it('ignores non-runtime targets and states whose target IDs do not match', () => {
    applyEphemeralVmSshState(USER_TARGET_ID, connectionState(USER_TARGET_ID))
    applyEphemeralVmSshState(RUNTIME_TARGET_ID, connectionState(OTHER_RUNTIME_TARGET_ID))

    expect(useAppStore.getState().sshConnectionStates).toEqual(new Map())
  })

  it('applies a runtime-owned state to the matching target', () => {
    const state = connectionState(RUNTIME_TARGET_ID, { connectionGeneration: 4 })

    applyEphemeralVmSshState(RUNTIME_TARGET_ID, state)

    expect(useAppStore.getState().sshConnectionStates.get(RUNTIME_TARGET_ID)).toEqual(state)
  })
})

describe('hydrateEphemeralVmSshAuthority', () => {
  it('hydrates complete connected authority without calling ssh.connect', async () => {
    const state = connectionState(RUNTIME_TARGET_ID, { connectionGeneration: 7 })
    getStateMock.mockResolvedValue(state)

    await expect(hydrateEphemeralVmSshAuthority(RUNTIME_TARGET_ID)).resolves.toBe(true)

    expect(getStateMock).toHaveBeenCalledTimes(1)
    expect(getStateMock).toHaveBeenCalledWith({ targetId: RUNTIME_TARGET_ID })
    expect(useAppStore.getState().sshConnectionStates.get(RUNTIME_TARGET_ID)).toEqual(state)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('does not query or connect for a non-runtime target', async () => {
    getStateMock.mockResolvedValue(connectionState(USER_TARGET_ID))

    await expect(hydrateEphemeralVmSshAuthority(USER_TARGET_ID)).resolves.toBe(false)

    expect(getStateMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
  })

  const invalidAuthorityCases: [string, SshConnectionState | null][] = [
    ['missing state', null],
    ['mismatched target ID', connectionState(OTHER_RUNTIME_TARGET_ID)],
    ['disconnected state', connectionState(RUNTIME_TARGET_ID, { status: 'disconnected' })],
    ['missing provider epoch', connectionState(RUNTIME_TARGET_ID, { providerEpoch: undefined })],
    [
      'empty provider epoch',
      connectionState(RUNTIME_TARGET_ID, { providerEpoch: '' as SshProviderEpoch })
    ],
    [
      'missing connection generation',
      connectionState(RUNTIME_TARGET_ID, { connectionGeneration: undefined })
    ],
    [
      'negative connection generation',
      connectionState(RUNTIME_TARGET_ID, { connectionGeneration: -1 })
    ],
    [
      'fractional connection generation',
      connectionState(RUNTIME_TARGET_ID, { connectionGeneration: 1.5 })
    ],
    [
      'non-finite connection generation',
      connectionState(RUNTIME_TARGET_ID, { connectionGeneration: Infinity })
    ],
    [
      'NaN connection generation',
      connectionState(RUNTIME_TARGET_ID, { connectionGeneration: Number.NaN })
    ]
  ]

  it.each(invalidAuthorityCases)('fails closed for %s', async (_description, state) => {
    getStateMock.mockResolvedValue(state)

    await expect(hydrateEphemeralVmSshAuthority(RUNTIME_TARGET_ID)).resolves.toBe(false)

    expect(useAppStore.getState().sshConnectionStates.has(RUNTIME_TARGET_ID)).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('fails closed when ssh.getState rejects', async () => {
    getStateMock.mockRejectedValue(new Error('provider unavailable'))

    await expect(hydrateEphemeralVmSshAuthority(RUNTIME_TARGET_ID)).resolves.toBe(false)

    expect(useAppStore.getState().sshConnectionStates.has(RUNTIME_TARGET_ID)).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('retains a newer event-applied authority instead of regressing its generation', async () => {
    const eventState = connectionState(RUNTIME_TARGET_ID, {
      providerEpoch: 'new-event-epoch' as SshProviderEpoch,
      connectionGeneration: 9
    })
    const fetchedState = connectionState(RUNTIME_TARGET_ID, {
      providerEpoch: 'older-fetched-epoch' as SshProviderEpoch,
      connectionGeneration: 8
    })
    useAppStore.setState({ sshConnectionStates: new Map([[RUNTIME_TARGET_ID, eventState]]) })
    getStateMock.mockResolvedValue(fetchedState)

    await expect(hydrateEphemeralVmSshAuthority(RUNTIME_TARGET_ID)).resolves.toBe(true)

    expect(useAppStore.getState().sshConnectionStates.get(RUNTIME_TARGET_ID)).toEqual(eventState)
    expect(connectMock).not.toHaveBeenCalled()
  })
})

describe('clearEphemeralVmSshAuthority', () => {
  it('removes only the runtime target state and preserves other SSH state', () => {
    const runtimeState = connectionState(RUNTIME_TARGET_ID)
    const userState = connectionState(USER_TARGET_ID)
    useAppStore.setState({
      sshConnectionStates: new Map([
        [RUNTIME_TARGET_ID, runtimeState],
        [USER_TARGET_ID, userState]
      ]),
      sshTargetLabels: new Map([
        [RUNTIME_TARGET_ID, 'Ephemeral VM'],
        [USER_TARGET_ID, 'User host']
      ])
    })

    clearEphemeralVmSshAuthority(RUNTIME_TARGET_ID)
    clearEphemeralVmSshAuthority(USER_TARGET_ID)

    expect(useAppStore.getState().sshConnectionStates).toEqual(
      new Map([[USER_TARGET_ID, userState]])
    )
    expect(useAppStore.getState().sshTargetLabels).toEqual(
      new Map([
        [RUNTIME_TARGET_ID, 'Ephemeral VM'],
        [USER_TARGET_ID, 'User host']
      ])
    )
  })
})
