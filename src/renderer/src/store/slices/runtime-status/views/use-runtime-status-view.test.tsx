// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useAppStore } from '../../../index'
import {
  usePairedRuntimeParkingEnvironmentIds,
  useRuntimeHostDisconnected
} from './use-runtime-status-view'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

it('rebinds host scopes and observes blocked and cleared runtime status', () => {
  const original = useAppStore.getState()
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  const container = document.createElement('div')
  const root = createRoot(container)
  function Probe({ environmentId }: { environmentId: string | null }) {
    const disconnected = useRuntimeHostDisconnected(environmentId)
    const parking = usePairedRuntimeParkingEnvironmentIds()
    return (
      <span>
        {String(disconnected)}:{parking.size}
      </span>
    )
  }
  try {
    for (const environmentId of ['a', 'b', null, 'a']) {
      act(() =>
        root.render(
          <StrictMode>
            <Probe environmentId={environmentId} />
            <Probe environmentId={environmentId} />
          </StrictMode>
        )
      )
      expect(container.textContent).toBe('false:0false:0')
      if (environmentId !== null) {
        act(() =>
          useAppStore.getState().setRuntimeEnvironmentStatus(environmentId, {
            status: null,
            checkedAt: 1,
            snapshot: {
              environmentId,
              pairingRevision: 1,
              checkedAt: 1,
              sequence: 1,
              status: null,
              verification: 'unavailable',
              transport: 'ready'
            }
          })
        )
        act(() =>
          useAppStore.getState().setRuntimeEnvironmentStatus(environmentId, {
            status: null,
            checkedAt: 2,
            snapshot: {
              environmentId,
              pairingRevision: 1,
              checkedAt: 2,
              sequence: 2,
              status: null,
              verification: 'blocked',
              transport: 'ready'
            }
          })
        )
        expect(container.textContent).toBe('true:0true:0')
        act(() => useAppStore.getState().clearRuntimeEnvironmentStatus(environmentId))
        expect(container.textContent).toBe('false:0false:0')
      }
    }
  } finally {
    act(() => root.unmount())
    useAppStore.setState(original, true)
  }
})

it('observes a commit between render and subscription without waiting for another publication', () => {
  const original = useAppStore.getState()
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  const container = document.createElement('div')
  const root = createRoot(container)
  function Probe() {
    return <output>{String(useRuntimeHostDisconnected('race'))}</output>
  }
  function CommitBeforeSubscription() {
    useLayoutEffect(() => {
      useAppStore.getState().setRuntimeEnvironmentStatus('race', { status: null, checkedAt: 1 })
    }, [])
    return null
  }
  try {
    act(() =>
      root.render(
        <>
          <Probe />
          <CommitBeforeSubscription />
        </>
      )
    )
    expect(container.textContent).toBe('true')
  } finally {
    act(() => root.unmount())
    useAppStore.setState(original, true)
  }
})
