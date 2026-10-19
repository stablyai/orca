// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { useAppStore } from '@/store'
import { useRuntimeEnvironmentCatalog } from './use-runtime-environment-catalog'

const initialState = useAppStore.getInitialState()
const list = vi.fn<() => Promise<PublicKnownRuntimeEnvironment[]>>()
const getStatus = vi.fn(async () => {
  throw new Error('host is unreachable')
})
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
const environment: PublicKnownRuntimeEnvironment = {
  id: 'env-a',
  name: 'Managed host',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [
    { id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://localhost:6768' }
  ],
  preferredEndpointId: 'ws-a'
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  list.mockReset().mockResolvedValue([])
  getStatus.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtimeEnvironments: { list, getStatus, getStatusSnapshots: async () => [] }
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  if (previousApi) {
    Object.defineProperty(window, 'api', previousApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('shows a managed host published after Settings finished its initial list request', async () => {
  const { result } = renderHook(useRuntimeEnvironmentCatalog)
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(list).toHaveBeenCalledTimes(1)
  act(() => useAppStore.setState({ runtimeEnvironments: [environment] }))
  expect(result.current.environments).toEqual([environment])
  expect(list).toHaveBeenCalledTimes(1)
  expect(getStatus).not.toHaveBeenCalled()
})

it('follows saved host changes while contact with the host is unavailable', async () => {
  list.mockResolvedValue([environment])
  const { result } = renderHook(useRuntimeEnvironmentCatalog)
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  const renamed = { ...environment, name: 'Renamed host', updatedAt: 2 }
  act(() => useAppStore.setState({ runtimeEnvironments: [renamed] }))
  expect(result.current.environments).toEqual([renamed])
  act(() => useAppStore.setState({ runtimeEnvironments: [] }))
  expect(result.current.environments).toEqual([])
  expect(list).toHaveBeenCalledTimes(1)
  expect(getStatus).toHaveBeenCalledTimes(1)
})

it('continues hiding recipe-created VM environments from the saved-server list', async () => {
  const { result } = renderHook(useRuntimeEnvironmentCatalog)
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  const vm: PublicKnownRuntimeEnvironment = { ...environment, id: 'env-vm', source: 'ephemeral-vm' }
  act(() => useAppStore.setState({ runtimeEnvironments: [vm, environment] }))
  expect(result.current.environments).toEqual([environment])
})
