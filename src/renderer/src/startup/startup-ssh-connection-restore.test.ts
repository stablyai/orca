import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SshConnectionState, SshProviderEpoch, SshTarget } from '../../../shared/ssh-types'
import { restoreSshConnectionsForStartup } from './startup-ssh-connection-restore'

function connectedState(targetId: string): SshConnectionState {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    providerEpoch: 'epoch' as SshProviderEpoch,
    connectionGeneration: 1,
    remotePlatform: 'linux'
  }
}

function target(id: string, lastRequiredPassphrase = false): SshTarget {
  return {
    id,
    label: id,
    host: `${id}.example`,
    port: 22,
    username: 'orca',
    lastRequiredPassphrase
  }
}

type Harness = {
  connect: Mock<(targetId: string) => Promise<SshConnectionState | null>>
  getState: Mock<(targetId: string) => Promise<SshConnectionState | null>>
  setDeferredSshReconnectTargets: Mock<(targetIds: string[]) => void>
  removeDeferredSshReconnectTarget: Mock<(targetId: string) => void>
  publishSshConnectionState: Mock<(targetId: string, state: SshConnectionState) => void>
}

let harness: Harness

function installWindowApi(targets: SshTarget[]): void {
  harness = {
    connect: vi.fn(),
    getState: vi.fn().mockResolvedValue(null),
    setDeferredSshReconnectTargets: vi.fn(),
    removeDeferredSshReconnectTarget: vi.fn(),
    publishSshConnectionState: vi.fn()
  }
  vi.stubGlobal('window', {
    api: {
      app: { startupDiagnostic: undefined },
      ssh: {
        listTargets: vi.fn().mockResolvedValue(targets),
        connect: (args: { targetId: string }) => harness.connect(args.targetId),
        getState: (args: { targetId: string }) => harness.getState(args.targetId)
      }
    }
  })
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('restoreSshConnectionsForStartup', () => {
  it('does not wait on a target that owns no immediately-mounted pane', async () => {
    vi.useFakeTimers()
    installWindowApi([target('ssh-active'), target('ssh-asleep')])
    // The asleep host never answers — the old code awaited it for the full timeout.
    harness.connect.mockImplementation((targetId: string) =>
      targetId === 'ssh-active'
        ? Promise.resolve(connectedState(targetId))
        : new Promise<SshConnectionState>(() => {})
    )

    let settled = false
    const restore = restoreSshConnectionsForStartup({
      connectionIds: ['ssh-active', 'ssh-asleep'],
      blockingConnectionIds: ['ssh-active'],
      setDeferredSshReconnectTargets: harness.setDeferredSshReconnectTargets,
      removeDeferredSshReconnectTarget: harness.removeDeferredSshReconnectTarget,
      publishSshConnectionState: harness.publishSshConnectionState
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(0)
    await restore
    expect(settled).toBe(true)
    // Both were dialled; only the active one gated restoration.
    expect(harness.connect).toHaveBeenCalledWith('ssh-active')
    expect(harness.connect).toHaveBeenCalledWith('ssh-asleep')
    expect(harness.publishSshConnectionState).toHaveBeenCalledWith(
      'ssh-active',
      connectedState('ssh-active')
    )
    // The unreachable host is deferred, so its panes reattach on tab focus.
    expect(harness.setDeferredSshReconnectTargets).toHaveBeenCalledWith(['ssh-asleep'])
  })

  it('awaits the target that owns the active workspace', async () => {
    vi.useFakeTimers()
    installWindowApi([target('ssh-active')])
    harness.connect.mockReturnValue(new Promise<SshConnectionState>(() => {}))

    let settled = false
    const restore = restoreSshConnectionsForStartup({
      connectionIds: ['ssh-active'],
      blockingConnectionIds: ['ssh-active'],
      setDeferredSshReconnectTargets: harness.setDeferredSshReconnectTargets,
      removeDeferredSshReconnectTarget: harness.removeDeferredSshReconnectTarget,
      publishSshConnectionState: harness.publishSshConnectionState
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(14_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await restore
    expect(settled).toBe(true)
    expect(harness.setDeferredSshReconnectTargets).toHaveBeenLastCalledWith(['ssh-active'])
  })

  it('clears the deferred flag once a background target connects', async () => {
    installWindowApi([target('ssh-bg')])
    harness.connect.mockResolvedValue(connectedState('ssh-bg'))

    await restoreSshConnectionsForStartup({
      connectionIds: ['ssh-bg'],
      blockingConnectionIds: [],
      setDeferredSshReconnectTargets: harness.setDeferredSshReconnectTargets,
      removeDeferredSshReconnectTarget: harness.removeDeferredSshReconnectTarget,
      publishSshConnectionState: harness.publishSshConnectionState
    })
    await vi.waitFor(() =>
      expect(harness.removeDeferredSshReconnectTarget).toHaveBeenCalledWith('ssh-bg')
    )
    expect(harness.publishSshConnectionState).toHaveBeenCalledWith(
      'ssh-bg',
      connectedState('ssh-bg')
    )
  })

  it('does not push a connected background target back into the deferred list', async () => {
    installWindowApi([target('ssh-active'), target('ssh-bg')])
    // The active host never answers and times out; the background host connects first.
    harness.connect.mockImplementation((targetId: string) =>
      targetId === 'ssh-bg'
        ? Promise.resolve(connectedState(targetId))
        : new Promise<SshConnectionState>(() => {})
    )

    await restoreSshConnectionsForStartup({
      connectionIds: ['ssh-active', 'ssh-bg'],
      blockingConnectionIds: ['ssh-active'],
      setDeferredSshReconnectTargets: harness.setDeferredSshReconnectTargets,
      removeDeferredSshReconnectTarget: harness.removeDeferredSshReconnectTarget,
      publishSshConnectionState: harness.publishSshConnectionState
    })

    expect(harness.removeDeferredSshReconnectTarget).toHaveBeenCalledWith('ssh-bg')
    // The timed-out rewrite must not resurrect the reachable background target: a deferred
    // connected target sends fresh panes down the cold-restore path instead of the normal one.
    expect(harness.setDeferredSshReconnectTargets).toHaveBeenLastCalledWith(['ssh-active'])
  }, 30_000)

  it('keeps passphrase targets deferred and never dials them', async () => {
    installWindowApi([target('ssh-key', true), target('ssh-bg')])
    harness.connect.mockResolvedValue(connectedState('ssh-bg'))

    await restoreSshConnectionsForStartup({
      connectionIds: ['ssh-key', 'ssh-bg'],
      blockingConnectionIds: [],
      setDeferredSshReconnectTargets: harness.setDeferredSshReconnectTargets,
      removeDeferredSshReconnectTarget: harness.removeDeferredSshReconnectTarget,
      publishSshConnectionState: harness.publishSshConnectionState
    })

    expect(harness.connect).not.toHaveBeenCalledWith('ssh-key')
    expect(harness.setDeferredSshReconnectTargets).toHaveBeenCalledWith(['ssh-key', 'ssh-bg'])
  })

  it('awaits every target when no blocking set is supplied', async () => {
    vi.useFakeTimers()
    installWindowApi([target('ssh-a'), target('ssh-b')])
    harness.connect.mockReturnValue(new Promise<SshConnectionState>(() => {}))

    let settled = false
    const restore = restoreSshConnectionsForStartup({
      connectionIds: ['ssh-a', 'ssh-b'],
      setDeferredSshReconnectTargets: harness.setDeferredSshReconnectTargets,
      removeDeferredSshReconnectTarget: harness.removeDeferredSshReconnectTarget,
      publishSshConnectionState: harness.publishSshConnectionState
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(14_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await restore
    expect(harness.setDeferredSshReconnectTargets).toHaveBeenLastCalledWith(['ssh-a', 'ssh-b'])
  })
})
