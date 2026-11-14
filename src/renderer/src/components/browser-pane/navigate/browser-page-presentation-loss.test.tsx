// @vitest-environment happy-dom
import { act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'
import {
  annotateBrowserPageHandles,
  copyBrowserPageHandles
} from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import {
  captureBrowserInitializationDelivery,
  isBrowserInitializationDeliveryCurrent,
  installBrowserInitializationPresentationLifetime
} from '@/runtime/web-session-tabs-sync/browser-initialization-presentation'
import { clearWebSessionTabsTrackingForEnvironment } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import {
  getRuntimeEnvironmentRevision,
  replaceRuntimeEnvironmentRevisions
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  ENV,
  WT
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-fixtures'
import {
  installFrameOrderingHarness,
  runtimeCall
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-ordering-test-harness'
import { snapshot, response, publish, page } from './browser-page-initialization-fixture'

installFrameOrderingHarness()
let stopLifetime = () => {}
let diagnostics: Parameters<
  NonNullable<typeof window.api.runtimeEnvironments.onSharedControlDiagnostics>
>[0]
afterEach(() => stopLifetime())
beforeEach(async () => {
  Object.assign(window.api.runtimeEnvironments, {
    onSharedControlDiagnostics: (callback: typeof diagnostics) => {
      diagnostics = callback
      return () => {
        diagnostics = () => {}
      }
    }
  })
  stopLifetime = installBrowserInitializationPresentationLifetime()
  await publish(snapshot('https://example.internal/S', 1))
})

it.each([750, 7500])(
  'skips loss traversal after a failed dispatch and revokes a fresh one-shot receipt among %s handles',
  async (count) => {
    const loss = {
      environmentId: ENV,
      transportGeneration: 1,
      diagnostics: {
        state: 'closed' as const,
        pendingRequestCount: 0,
        subscriptionCount: 1,
        reconnectAttempt: 0,
        lastConnectedAt: 1,
        lastClose: null,
        lastError: null
      }
    }
    const original = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
    const unrelated = { ...original, environmentId: 'other-environment' }
    const handles = { ...useAppStore.getState().remoteBrowserPageHandlesByPageId }
    for (let i = 0; i < count; i++) {
      handles[`unrelated-${i}`] = unrelated
    }
    useAppStore.setState({
      remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
        handles,
        Object.keys(handles),
        useAppStore.getState().remoteBrowserPageHandlesByPageId
      )
    })
    act(() => diagnostics(loss))
    let visits = 0
    let publications = 0
    const countHandles = () => {
      useAppStore.setState((state) => ({
        remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
          new Proxy(state.remoteBrowserPageHandlesByPageId, {
            ownKeys: (target) => {
              visits++
              return Reflect.ownKeys(target)
            }
          }),
          [],
          state.remoteBrowserPageHandlesByPageId
        )
      }))
      visits = 0
      publications = 0
    }
    runtimeCall.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      await expect(
        refreshWebRuntimeSessionTabsSnapshot(ENV, WT, {
          acceptCurrentSnapshot: true,
          errorMode: 'throw'
        })
      ).rejects.toThrow('offline')
    })
    countHandles()
    const stop = useAppStore.subscribe(() => {
      publications++
    })
    try {
      act(() => diagnostics(loss))
      expect(visits).toBe(0)
      expect(publications).toBe(0)
      runtimeCall.mockResolvedValueOnce(
        response(snapshot('https://example.internal/ordinary', 3, null))
      )
      await act(async () => {
        await refreshWebRuntimeSessionTabsSnapshot(ENV, WT, { acceptCurrentSnapshot: true })
      })
      countHandles()
      act(() => diagnostics(loss))
      expect(visits).toBe(0)
      expect(publications).toBe(0)
      runtimeCall.mockResolvedValueOnce(response(snapshot('https://example.internal/stale', 2)))
      await act(async () => {
        await refreshWebRuntimeSessionTabsSnapshot(ENV, WT)
      })
      countHandles()
      act(() => diagnostics(loss))
      expect(visits).toBe(0)
      expect(publications).toBe(0)
      runtimeCall.mockResolvedValueOnce(response(snapshot('https://example.internal/fresh', 4)))
      await act(async () => {
        await refreshWebRuntimeSessionTabsSnapshot(ENV, WT, { acceptCurrentSnapshot: true })
      })
      expect(
        useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a'].initializationPresentation
          ?.disposition
      ).toBe('pending')
      countHandles()
      act(() => diagnostics(loss))
      expect(visits).toBe(2)
      expect(publications).toBe(1)
      expect(
        useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a'].initializationPresentation
          ?.disposition
      ).toBe('unavailable')
      expect(useAppStore.getState().remoteBrowserPageHandlesByPageId['unrelated-0']).toBe(unrelated)
      expect(page()?.url).toBe('https://example.internal/fresh')
      act(() => diagnostics(loss))
      expect(visits).toBe(2)
      expect(publications).toBe(1)
    } finally {
      stop()
    }
  }
)

it.each([750, 7500])(
  'revokes %s affected pages in one publication while leaving another environment untouched',
  (count) => {
    const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
    const handles = { ...useAppStore.getState().remoteBrowserPageHandlesByPageId }
    for (let i = 0; i < count; i++) {
      handles[`scale-${i}`] = { ...handle, remotePageId: `remote-${i}` }
    }
    const unrelated = { ...handle, environmentId: 'other-environment' }
    handles['unrelated-page'] = unrelated
    useAppStore.setState({
      remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
        handles,
        Object.keys(handles),
        useAppStore.getState().remoteBrowserPageHandlesByPageId
      )
    })
    const pages = useAppStore.getState().browserPagesByWorkspace
    let publications = 0
    const unsubscribe = useAppStore.subscribe(() => {
      publications++
    })
    const event = {
      environmentId: ENV,
      transportGeneration: 1,
      diagnostics: {
        state: 'closed' as const,
        pendingRequestCount: 0,
        subscriptionCount: 1,
        reconnectAttempt: 0,
        lastConnectedAt: 1,
        lastClose: null,
        lastError: null
      }
    }
    try {
      act(() => diagnostics(event))
      expect(publications).toBe(1)
      const next = useAppStore.getState()
      expect(next.browserPagesByWorkspace).toBe(pages)
      expect(next.remoteBrowserPageHandlesByPageId['unrelated-page']).toBe(unrelated)
      for (let i = 0; i < count; i++) {
        expect(
          next.remoteBrowserPageHandlesByPageId[`scale-${i}`].initializationPresentation
            ?.disposition
        ).toBe('unavailable')
      }
      act(() => diagnostics(event))
      expect(publications).toBe(1)
      stopLifetime()
      stopLifetime = () => {}
      act(() => diagnostics(event))
      expect(publications).toBe(1)
    } finally {
      unsubscribe()
    }
  }
)

it.each([750, 7500])(
  'revokes retained pending after tracking clears with %s unrelated handles',
  (count) => {
    const retained = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
    const committed = { ...retained, initializationPresentation: undefined }
    const unrelated = { ...retained, environmentId: 'unrelated-environment' }
    const handles: Record<string, RemoteBrowserPageHandle> = { 'page-a': retained, committed }
    for (let i = 0; i < count; i++) {
      handles[`unrelated-${i}`] = unrelated
    }
    let enumerations = 0
    let reads = 0
    const counted = new Proxy(handles, {
      ownKeys: (target) => {
        enumerations++
        return Reflect.ownKeys(target)
      },
      get: (target, key) => {
        reads++
        return typeof key === 'string' ? target[key] : undefined
      }
    })
    useAppStore.setState({
      remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
        counted,
        Object.keys(handles),
        useAppStore.getState().remoteBrowserPageHandlesByPageId
      )
    })
    clearWebSessionTabsTrackingForEnvironment(ENV)
    expect(useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']).toBe(retained)
    enumerations = 0
    reads = 0
    let publications = 0
    const stop = useAppStore.subscribe(() => {
      publications++
    })
    const event = {
      environmentId: ENV,
      transportGeneration: 1,
      diagnostics: {
        state: 'closed' as const,
        pendingRequestCount: 0,
        subscriptionCount: 1,
        reconnectAttempt: 0,
        lastConnectedAt: 1,
        lastClose: null,
        lastError: null
      }
    }
    try {
      act(() => diagnostics(event))
      expect(enumerations).toBe(2) // One selection and one immutable copy.
      expect(reads).toBeLessThanOrEqual(3 * (count + 2))
      expect(publications).toBe(1)
      expect(
        useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a'].initializationPresentation
          ?.disposition
      ).toBe('unavailable')
      expect(useAppStore.getState().remoteBrowserPageHandlesByPageId.committed).toBe(committed)
      expect(useAppStore.getState().remoteBrowserPageHandlesByPageId['unrelated-0']).toBe(unrelated)
      expect(page()?.url).toBe('https://example.internal/S')
      act(() => diagnostics(event))
      expect(enumerations).toBe(2)
      expect(publications).toBe(1)
    } finally {
      stop()
    }
  }
)

it.each(['retirement', 'teardown'] as const)(
  'batches multiple environments on %s and preserves a successor against stale diagnostics',
  (kind) => {
    const environments = [ENV, 'second-environment', 'third-environment']
    replaceRuntimeEnvironmentRevisions(
      environments.map((id) => ({
        id,
        createdAt: 0,
        pairingRevision: getRuntimeEnvironmentRevision(id) ?? 1
      }))
    )
    const original = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
    const deliveries = environments.map((id) => captureBrowserInitializationDelivery(id))
    const handles: Record<string, RemoteBrowserPageHandle> = {}
    for (let i = 0; i < environments.length; i++) {
      handles[`batch-${i}`] = {
        ...original,
        environmentId: environments[i],
        remotePageId: `batch-${i}`,
        initializationPresentation: {
          disposition: 'pending',
          delivery: deliveries[i],
          receivedFrame: 1
        }
      }
    }
    // A closed page has no retained handle and must not be recreated.
    let enumerations = 0
    useAppStore.setState({
      remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
        new Proxy(handles, {
          ownKeys: (target) => {
            enumerations++
            return Reflect.ownKeys(target)
          }
        }),
        ['page-a', ...Object.keys(handles)],
        useAppStore.getState().remoteBrowserPageHandlesByPageId
      )
    })
    enumerations = 0
    let publications = 0
    const stop = useAppStore.subscribe(() => {
      publications++
    })
    try {
      if (kind === 'retirement') {
        replaceRuntimeEnvironmentRevisions([])
      } else {
        stopLifetime()
        stopLifetime = () => {}
      }
      expect(enumerations).toBe(2)
      expect(publications).toBe(1)
      expect(
        deliveries.every((delivery) => !isBrowserInitializationDeliveryCurrent(delivery))
      ).toBe(true)
      for (let i = 0; i < environments.length; i++) {
        expect(
          useAppStore.getState().remoteBrowserPageHandlesByPageId[`batch-${i}`]
            .initializationPresentation?.disposition
        ).toBe('unavailable')
      }
      expect(useAppStore.getState().remoteBrowserPageHandlesByPageId.closed).toBeUndefined()
      const successor = captureBrowserInitializationDelivery(ENV)
      useAppStore.setState((s) => ({
        remoteBrowserPageHandlesByPageId: Object.assign(
          copyBrowserPageHandles(s.remoteBrowserPageHandlesByPageId, ['batch-0']),
          {
            'batch-0': {
              ...s.remoteBrowserPageHandlesByPageId['batch-0'],
              initializationPresentation: {
                disposition: 'pending',
                delivery: successor,
                receivedFrame: 2
              }
            }
          }
        )
      }))
      const before = useAppStore.getState().remoteBrowserPageHandlesByPageId
      diagnostics({
        environmentId: ENV,
        transportGeneration: -2,
        diagnostics: {
          state: 'closed',
          pendingRequestCount: 0,
          subscriptionCount: 1,
          reconnectAttempt: 0,
          lastConnectedAt: 1,
          lastClose: null,
          lastError: null
        }
      })
      expect(useAppStore.getState().remoteBrowserPageHandlesByPageId).toBe(before)
    } finally {
      stop()
    }
  }
)
