// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
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
const probeFailed = (id: string): RuntimeEnvironmentStatus =>
  entry(id, { verification: 'unavailable', transport: 'ready' })
const refused = (id: string): RuntimeEnvironmentStatus =>
  entry(id, { verification: 'blocked', transport: 'disconnected' })
const retired = (id: string): RuntimeEnvironmentStatus =>
  entry(id, { verification: 'blocked', transport: 'disconnected', retired: true })

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
  it('says nothing for a connected host or a local chat', () => {
    expect(renderHook(() => useNativeChatHostOutage(remote)).result.current).toBeNull()
    expect(renderHook(() => useNativeChatHostOutage({ kind: 'local' })).result.current).toBeNull()
  })

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

  it('treats a probe still answering on a recovered transport as reconnecting, not offline', () => {
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    setHost('env-a', probeFailed('env-a'))
    expect(result.current).toBeNull()
    advance(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS)
    expect(result.current?.kind).toBe('reconnecting')
  })

  it('treats a host with no status yet as reconnecting after the grace', () => {
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    setHost('env-a', null)
    expect(result.current).toBeNull()
    advance(NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS)
    expect(result.current?.kind).toBe('reconnecting')
  })

  it.each([
    ['retired by Disconnect', retired, true],
    [
      'never reached',
      (id: string) => entry(id, { verification: 'unavailable', transport: 'unknown' }),
      true
    ],
    // Auth or protocol refusals turn a reconnect away the same way, so none is offered.
    ['refused', refused, false]
  ])('says a %s host is offline at once', (_name, offline, canReconnect) => {
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    setHost('env-a', offline('env-a'))
    expect(result.current).toMatchObject({ kind: 'offline', environmentId: 'env-a', canReconnect })
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

  it('falls back to the host id when its name is blank', () => {
    useAppStore.setState({ runtimeEnvironments: [environment('env-a', '  ')] })
    setHost('env-a', refused('env-a'))
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    expect(result.current?.hostLabel).toBe('env-a')
  })

  it('names a temporary VM host by its environment name', () => {
    useAppStore.setState({
      runtimeEnvironments: [environment('vm-1', 'repo (vm 1)', 'ephemeral-vm')]
    })
    setHost('vm-1', refused('vm-1'))
    const { result } = renderHook(() =>
      useNativeChatHostOutage({ kind: 'environment', environmentId: 'vm-1' })
    )
    expect(result.current).toMatchObject({ kind: 'offline', hostLabel: 'repo (vm 1)' })
  })

  it("names the host by the user's label first", () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/home/test'),
          hostSettingOverrides: { 'runtime:env-a': { displayLabel: 'GPU rig' } }
        }
      })
    })
    setHost('env-a', refused('env-a'))
    const { result } = renderHook(() => useNativeChatHostOutage(remote))
    expect(result.current?.hostLabel).toBe('GPU rig')
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
