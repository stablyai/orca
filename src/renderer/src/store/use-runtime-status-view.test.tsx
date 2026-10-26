// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useAppStore } from './index'
import { readStoreListenerCount } from './store-listener-census'
import {
  usePairedRuntimeParkingEnvironmentIds,
  useRuntimeHostDisconnected
} from './use-runtime-status-view'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

it('shares one root subscription, rebinds host scopes, and releases Strict Mode remounts', () => {
  const original = useAppStore.getState()
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  const baseline = readStoreListenerCount()
  const container = document.createElement('div')
  const root = createRoot(container)
  let renders = 0
  function Probe({ environmentId }: { environmentId: string | null }) {
    renders += 1
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
      expect(readStoreListenerCount()).toBe((baseline ?? 0) + 1)
      expect(container.textContent).toBe('false:0false:0')
      if (environmentId !== null) {
        const mountedRenders = renders
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
        expect(renders).toBe(mountedRenders)
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
    expect(readStoreListenerCount()).toBe(baseline)
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
