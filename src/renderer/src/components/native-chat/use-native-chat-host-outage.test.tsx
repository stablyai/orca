// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS,
  useNativeChatHostOutage
} from './use-native-chat-host-outage'

const initialState = useAppStore.getState()
let sequence = 0

function environment(id: string, name: string, source?: 'ephemeral-vm') {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    ...(source ? { source } : {}),
    endpoints: [{ id: 'ws', kind: 'websocket' as const, label: 'ws', endpoint: 'ws://host' }],
    preferredEndpointId: 'ws'
  }
}

const liveStatus: RuntimeStatus = {
  runtimeId: 'runtime-1',
  rendererGraphEpoch: 1,
  graphStatus: 'ready',
  authoritativeWindowId: 1,
  desktopWindowStatus: 'available',
  liveTabCount: 0,
  liveLeafCount: 0
}

function entry(
  environmentId: string,
  fields: Pick<RuntimeHostStatusSnapshot, 'verification' | 'transport'> & { retired?: true },
  status: RuntimeStatus | null = null
): RuntimeEnvironmentStatus {
  return {
    snapshot: {
      environmentId,
      pairingRevision: 1,
      sequence: ++sequence,
      checkedAt: 1,
      status,
      ...fields
    },
    status,
    checkedAt: 1
  }
}

const connected = (id: string): RuntimeEnvironmentStatus =>
  entry(id, { verification: 'verified', transport: 'ready' }, liveStatus)
const transportDown = (id: string): RuntimeEnvironmentStatus =>
  entry(id, { verification: 'unavailable', transport: 'disconnected' })

const refused = (id: string): RuntimeEnvironmentStatus =>
  entry(id, { verification: 'blocked', transport: 'disconnected' })

function setHost(environmentId: string, status: RuntimeEnvironmentStatus | null): void {
  act(() => {
    const next = new Map(useAppStore.getState().runtimeStatusByEnvironmentId)
    if (status) {
      next.set(environmentId, status)
    } else {
      next.delete(environmentId)
    }
    useAppStore.setState({ runtimeStatusByEnvironmentId: next })
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const remote: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-a' }

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({
    runtimeEnvironments: [environment('env-a', 'Build box'), environment('env-b', 'Laptop')],
    runtimeStatusByEnvironmentId: new Map([
      ['env-a', connected('env-a')],
      ['env-b', connected('env-b')]
    ]),
    settings: getDefaultSettings('/home/test')
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState({
    runtimeEnvironments: initialState.runtimeEnvironments,
    runtimeStatusByEnvironmentId: initialState.runtimeStatusByEnvironmentId,
    settings: initialState.settings
  })
})

describe('useNativeChatHostOutage', () => {
  it('says a reconnecting host only after the grace, and drops it the moment the host is back', () => {
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    setHost('env-a', transportDown('env-a'))
    advance(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS - 1)
    expect(result.current).toBeNull()

    advance(1)
    expect(result.current).toMatchObject({ kind: 'reconnecting', hostLabel: 'Build box' })
    expect(result.current?.canReconnect).toBe(false)

    setHost('env-a', connected('env-a'))
    expect(result.current).toBeNull()
  })

  it('says nothing for a blip that recovers inside the grace, and starts the grace over next time', () => {
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    setHost('env-a', transportDown('env-a'))
    advance(1_500)
    setHost('env-a', connected('env-a'))
    advance(1_000)
    expect(result.current).toBeNull()

    setHost('env-a', transportDown('env-a'))
    advance(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS - 1)
    expect(result.current).toBeNull()
  })

  it('keeps saying offline through a retry probe, until the host is back', () => {
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    setHost('env-a', refused('env-a'))
    setHost('env-a', entry('env-a', { verification: 'checking', transport: 'unknown' }))
    expect(result.current?.kind).toBe('offline')

    setHost('env-a', connected('env-a'))
    expect(result.current).toBeNull()
    setHost('env-a', transportDown('env-a'))
    expect(result.current).toBeNull()
  })

  it("starts the grace over when the chat's host changes", () => {
    setHost('env-a', transportDown('env-a'))
    setHost('env-b', transportDown('env-b'))
    const { result, rerender } = renderHook(
      ({ target }: { target: RuntimeClientTarget }) => useNativeChatHostOutage(target),
      { initialProps: { target: remote } }
    )
    advance(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS)
    expect(result.current?.hostLabel).toBe('Build box')

    rerender({ target: { kind: 'environment', environmentId: 'env-b' } })
    expect(result.current).toBeNull()
    advance(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS)
    expect(result.current?.hostLabel).toBe('Laptop')
  })
})
