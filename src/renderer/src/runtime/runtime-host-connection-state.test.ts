import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionState,
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
  it('counts connected remote servers as connected hosts', () => {
    // Why: "connected" = attached/reachable (active-agnostic), matching Settings.
    // There is no separate "available" state — a reachable host is just Connected.
    expect(runtimeStatusForOverall('connected')).toBe('connected')
    expect(isConnectedRuntimeHostState('connected')).toBe(true)
  })

  it('keeps reconnecting and disconnected remote servers out of the connected count', () => {
    expect(runtimeStatusForOverall('reconnecting')).toBe('connecting')
    expect(runtimeStatusForOverall('disconnected')).toBe('disconnected')
    expect(isConnectedRuntimeHostState('reconnecting')).toBe(false)
    expect(isConnectedRuntimeHostState('disconnected')).toBe(false)
  })

  it('still counts a workspace-window-closed remote server as a connected host', () => {
    // Why: the transport is healthy, so demoting it to disconnected would be a lie
    // in the other direction — only the wording changes (#12350).
    expect(runtimeStatusForOverall('workspace-window-closed')).toBe('connected')
    expect(isConnectedRuntimeHostState('workspace-window-closed')).toBe(true)
  })

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
