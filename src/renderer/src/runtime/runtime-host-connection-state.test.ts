import { describe, expect, it } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionState,
  runtimeHostConnectionStateForEntry,
  runtimeStatusForOverall
} from './runtime-host-connection-state'

function makeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'runtime-hub',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    desktopWindowStatus: 'available',
    liveTabCount: 0,
    liveLeafCount: 0,
    ...overrides
  }
}

const windowClosedStatus = makeStatus({
  graphStatus: 'unavailable',
  authoritativeWindowId: null,
  desktopWindowStatus: 'openable'
})

describe('runtime host connection state', () => {
  it('distinguishes a reachable host whose workspace window is closed', () => {
    expect(runtimeHostConnectionState({ hasStatusEntry: true, status: windowClosedStatus })).toBe(
      'workspace-window-closed'
    )
    expect(runtimeHostConnectionState({ hasStatusEntry: true, status: makeStatus() })).toBe(
      'connected'
    )
  })

  it('keeps transport failures ahead of a closed workspace window', () => {
    expect(runtimeHostConnectionState({ hasStatusEntry: false, status: null })).toBe('checking')
    expect(runtimeHostConnectionState({ hasStatusEntry: true, status: null })).toBe('disconnected')
    expect(
      runtimeHostConnectionState({
        hasStatusEntry: true,
        status: {
          ...windowClosedStatus,
          remoteControl: {
            state: 'reconnecting',
            pendingRequestCount: 0,
            subscriptionCount: 0,
            reconnectAttempt: 0,
            lastConnectedAt: null,
            lastClose: null,
            lastError: null
          }
        }
      })
    ).toBe('reconnecting')
  })

  function remoteControl(
    overrides: Partial<NonNullable<RuntimeStatus['remoteControl']>>
  ): NonNullable<RuntimeStatus['remoteControl']> {
    return {
      state: 'ready',
      pendingRequestCount: 0,
      subscriptionCount: 0,
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastClose: null,
      lastError: null,
      ...overrides
    }
  }

  it('uses outer transport diagnostics when status is unavailable', () => {
    expect(
      runtimeHostConnectionState({
        hasStatusEntry: true,
        status: null,
        remoteControl: remoteControl({ state: 'ready' })
      })
    ).toBe('runtime-unavailable')
    expect(
      runtimeHostConnectionState({
        hasStatusEntry: true,
        status: null,
        remoteControl: remoteControl({ state: 'reconnecting' })
      })
    ).toBe('reconnecting')
    for (const state of ['awaiting_ready', 'awaiting_authenticated'] as const) {
      expect(
        runtimeHostConnectionState({
          hasStatusEntry: true,
          status: null,
          remoteControl: remoteControl({ state })
        }),
        state
      ).toBe('checking')
    }
  })

  it('reports a cleanly closed control channel as disconnected even with no error', () => {
    // Clean close can leave lastError null; requiring an error paints dead hosts green.
    expect(
      runtimeHostConnectionState({
        hasStatusEntry: true,
        status: { ...makeStatus(), remoteControl: remoteControl({ state: 'closed' }) }
      })
    ).toBe('disconnected')
  })

  it('does not call a half-open handshake connected', () => {
    // Socket without completed ready/auth cannot run work and must not look connected.
    for (const state of ['awaiting_ready', 'awaiting_authenticated'] as const) {
      expect(
        runtimeHostConnectionState({
          hasStatusEntry: true,
          status: { ...makeStatus(), remoteControl: remoteControl({ state }) }
        }),
        state
      ).toBe('checking')
    }
  })

  it('does not hide a closed control channel behind workspace-window diagnostics', () => {
    expect(
      runtimeHostConnectionState({
        hasStatusEntry: true,
        status: {
          ...windowClosedStatus,
          remoteControl: {
            state: 'closed',
            pendingRequestCount: 0,
            subscriptionCount: 0,
            reconnectAttempt: 0,
            lastConnectedAt: null,
            lastClose: null,
            lastError: 'Connection closed'
          }
        }
      })
    ).toBe('disconnected')
  })
})

describe('runtime host connection state for a recorded status entry', () => {
  it('separates a host that was never probed from one a probe found unreachable', () => {
    // The sidebar read raw truthiness, which collapsed these two into the same red glyph.
    expect(runtimeHostConnectionStateForEntry(undefined)).toBe('checking')
    expect(runtimeHostConnectionStateForEntry({ status: null })).toBe('disconnected')
  })

  it('reads the remote-control diagnostics recorded beside a failed probe', () => {
    expect(
      runtimeHostConnectionStateForEntry({
        status: null,
        remoteControl: remoteControl('reconnecting')
      })
    ).toBe('reconnecting')
  })
})

function remoteControl(
  state: NonNullable<RuntimeStatus['remoteControl']>['state']
): NonNullable<RuntimeStatus['remoteControl']> {
  return {
    state,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 1,
    lastConnectedAt: null,
    lastClose: null,
    lastError: null
  }
}

it('does not report reconnecting after verification is terminally blocked', () => {
  expect(
    runtimeHostConnectionStateForEntry({
      status: null,
      snapshot: {
        environmentId: 'browser',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 1,
        status: null,
        verification: 'blocked',
        transport: 'disconnected'
      }
    })
  ).toBe('disconnected')
})

describe('snapshot transport evidence', () => {
  const snapshotWith = (
    transport: RuntimeHostStatusSnapshot['transport'],
    verification: RuntimeHostStatusSnapshot['verification']
  ): RuntimeHostStatusSnapshot => ({
    environmentId: 'host',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: null,
    verification,
    transport
  })

  // Enumerate destructive verdicts so only evidence proving lost transport can reach them.
  it.each([
    ['disconnected', 'unavailable', 'reconnecting'],
    ['disconnected', 'checking', 'reconnecting'],
    ['ready', 'unavailable', 'runtime-unavailable'],
    // A null status under 'checking' is answered by the checking guard, before transport.
    ['ready', 'checking', 'checking'],
    ['connecting', 'checking', 'checking'],
    ['unknown', 'checking', 'checking'],
    // Was 'disconnected': a transport still being established fell through to the default.
    ['connecting', 'unavailable', 'checking'],
    // Unknown means never attempted; unreachable paired hosts can remain here permanently. Preserve Connect affordance.
    ['unknown', 'unavailable', 'disconnected']
  ] as const)('reads transport=%s verification=%s as %s', (transport, verification, expected) => {
    expect(
      runtimeHostConnectionStateForEntry({
        status: null,
        snapshot: snapshotWith(transport, verification)
      })
    ).toBe(expected)
  })

  // Powered-off paired hosts stay unknown forever; checking would hide Connect and leave a permanent status-bar spinner.
  it('keeps a never-contacted host actionable after its probe fails', () => {
    const state = runtimeHostConnectionStateForEntry({
      status: null,
      snapshot: snapshotWith('unknown', 'unavailable')
    })
    expect(isDisconnectedRuntimeHostState(state)).toBe(true)
    expect(runtimeStatusForOverall(state)).toBe('disconnected')
  })

  it('still lets a blocked or retired snapshot reach the disconnected verdict', () => {
    expect(
      runtimeHostConnectionStateForEntry({
        status: null,
        snapshot: snapshotWith('connecting', 'blocked')
      })
    ).toBe('disconnected')
    expect(
      runtimeHostConnectionStateForEntry({
        status: null,
        snapshot: { ...snapshotWith('connecting', 'unavailable'), retired: true }
      })
    ).toBe('disconnected')
  })

  it('keeps a closed control channel disconnected while the transport is connecting', () => {
    expect(
      runtimeHostConnectionStateForEntry({
        status: null,
        remoteControl: remoteControl('closed'),
        snapshot: snapshotWith('connecting', 'unavailable')
      })
    ).toBe('disconnected')
  })
})
