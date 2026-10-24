// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import { inPlaceSwitchCapabilityNow, useInPlaceSwitchCapability } from './in-place-switch-support'

const SWITCH = 'agent-session.structured.switch.v1:codex'
const environment = {
  id: 'paired',
  name: 'Host',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: 'paired',
  preferredEndpointId: 'endpoint',
  endpoints: [{ id: 'endpoint', kind: 'websocket' as const, label: 'Host', endpoint: 'ws://host' }]
}
const getStatus = vi.fn()
function Switch({ host = 'local' }: { host?: string }) {
  const supported = useInPlaceSwitchCapability(host, 'codex')
  return <button disabled={supported !== true}>{String(supported)}</button>
}
function snapshot(
  sequence: number,
  patch: Partial<RuntimeHostStatusSnapshot> = {}
): RuntimeHostStatusSnapshot {
  const response = createCompatibleRuntimeStatusResponse('paired')
  if (!response.ok) {
    throw new Error('Expected status')
  }
  return {
    environmentId: 'paired',
    pairingRevision: 1,
    sequence,
    checkedAt: sequence,
    transport: 'ready',
    verification: 'verified',
    status: { ...response.result, capabilities: [SWITCH] },
    ...patch
  }
}
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  setLocalRuntimeCapabilitiesForTests(null)
  getStatus.mockReset()
  Object.assign(window, { api: { ...window.api, runtime: { getStatus } } })
})
afterEach(cleanup)

it('activates once after failed boot, observes local publication, and never probes from reads or notifications', async () => {
  getStatus.mockRejectedValueOnce(new Error('boot unavailable'))
  await refreshLocalRuntimeCapabilities()
  expect(inPlaceSwitchCapabilityNow('local', 'codex')).toBeUndefined()
  let answer = (_value: { capabilities: string[] }) => {}
  getStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  render(<Switch />)
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  expect(getStatus).toHaveBeenCalledTimes(2)
  await act(async () => {
    answer({ capabilities: [SWITCH] })
  })
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false)
  for (let index = 0; index < 4; index++) {
    expect(inPlaceSwitchCapabilityNow('local', 'codex')).toBe(true)
    act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() }))
  }
  expect(getStatus).toHaveBeenCalledTimes(2)
  getStatus.mockResolvedValueOnce({ capabilities: [] })
  await act(async () => {
    await refreshLocalRuntimeCapabilities()
  })
  expect(screen.getByRole('button').textContent).toBe('false')
})

it('derives only the addressed catalog owner across publication, lost contact, revocation, replacement and legacy verification', async () => {
  setLocalRuntimeCapabilitiesForTests([])
  useAppStore.getState().setRuntimeEnvironments([environment])
  render(<Switch host="runtime:paired" />)
  expect(screen.getByRole('button').textContent).toBe('undefined')
  act(() => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(1)))
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false)
  const learned = snapshot(2, { verification: 'unavailable', transport: 'disconnected' })
  act(() => useAppStore.getState().applyRuntimeHostStatusSnapshot(learned))
  expect(inPlaceSwitchCapabilityNow('runtime:paired', 'codex')).toBe(true)
  expect(inPlaceSwitchCapabilityNow('runtime:other', 'codex')).toBeUndefined()
  act(() =>
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(3, { verification: 'blocked' }))
  )
  expect(screen.getByRole('button').textContent).toBe('undefined')
  act(() => useAppStore.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }]))
  act(() => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(10)))
  expect(inPlaceSwitchCapabilityNow('runtime:paired', 'codex')).toBeUndefined()
  const legacy = snapshot(11, { pairingRevision: 2 })
  if (!legacy.status) {
    throw new Error('Expected status')
  }
  delete legacy.status.capabilities
  act(() => useAppStore.getState().applyRuntimeHostStatusSnapshot(legacy))
  expect(screen.getByRole('button').textContent).toBe('false')
  act(() =>
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(12, { pairingRevision: 2 }))
  )
  expect(screen.getByRole('button').textContent).toBe('true')
  act(() =>
    useAppStore
      .getState()
      .applyRuntimeHostStatusSnapshot(snapshot(13, { pairingRevision: 2, retired: true }))
  )
  expect(screen.getByRole('button').textContent).toBe('undefined')
  expect(getStatus).not.toHaveBeenCalled()
})
