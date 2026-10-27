// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
const original = useAppStore.getState()
const container = document.createElement('div')
const root = createRoot(container)

afterEach(() => {
  act(() => root.unmount())
  useAppStore.setState(original, true)
})

it('does not render the workspace root for fresh evidence with unchanged parking', () => {
  let renders = 0
  function Probe() {
    const { pairedRuntimeParkingEnvironmentIds } = useTerminalWorkspaceFoundation()
    renders += 1
    return <output>{[...pairedRuntimeParkingEnvironmentIds].join(',')}</output>
  }
  act(() => root.render(<Probe />))
  const mountedRenders = renders
  for (let checkedAt = 1; checkedAt <= 20; checkedAt += 1) {
    const snapshot: RuntimeHostStatusSnapshot = {
      environmentId: 'env-a',
      pairingRevision: 1,
      sequence: checkedAt,
      checkedAt,
      status: null,
      verification: 'unavailable',
      transport: 'ready'
    }
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['env-a', { status: null, checkedAt, snapshot }]])
      })
    )
  }
  expect(renders - mountedRenders).toBe(0)
  const snapshot: RuntimeHostStatusSnapshot = {
    environmentId: 'env-a',
    pairingRevision: 1,
    sequence: 21,
    checkedAt: 21,
    verification: 'verified',
    transport: 'ready',
    status: {
      runtimeId: 'a',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY]
    }
  }
  act(() =>
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', { status: snapshot.status, snapshot, checkedAt: 21 }]
      ])
    })
  )
  expect(container.textContent).toBe('env-a')
  expect(renders - mountedRenders).toBe(1)
  act(() => useAppStore.getState().clearRuntimeEnvironmentStatus('env-a'))
  expect(container.textContent).toBe('')
  expect(renders - mountedRenders).toBe(2)
})
