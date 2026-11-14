import { copyBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createSessionTabsTabDeltaEncoder,
  createSessionTabsTabDeltaDecoder
} from '../../../../../shared/session-tabs-tab-delta'
import { SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY } from '../../../../../shared/session-tabs-runtime-capabilities'
import { buildPersistedBrowserPagesByWorkspace } from '@/lib/workspace/persistence/workspace-session-browser-tabs'
import { useAppStore } from '@/store'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { applyWebRuntimeSessionTabsAnswer } from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { createSessionWriteSubscriber } from '@/lib/workspace/persistence/session-write-subscriber'
import { installBrowserInitializationPresentationLifetime } from '@/runtime/web-session-tabs-sync/browser-initialization-presentation'
import { listRemoteRuntimeSessionTabsDeduped } from '@/runtime/web-session-tabs-sync/inventory/remote-runtime-session-tabs-inflight'
import { handleGlobalSessionEvent } from '@/runtime/web-session-tabs-sync/global-session-events'
import { VisibilityResumeCoordinator } from '@/runtime/web-session-tabs-sync/visibility-resume-coordinator'
import { getWebSessionTabsTrackingGeneration } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import {
  getRuntimeEnvironmentRevision,
  replaceRuntimeEnvironmentRevisions
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { nextReceivedSessionTabsFrame } from '@/runtime/web-session-tabs-sync/state'
import { resetBrowserClientHostIdForTests } from '@/runtime/browser/client-hosting/browser-client-host-identity'
import {
  ENV,
  WT
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-fixtures'
import {
  installFrameOrderingHarness,
  runtimeCall
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-ordering-test-harness'
import { useClientHostedPageUrlSubmission } from './use-client-hosted-page-url-submission'
import { routeBrowserPageInitializationAction } from './browser-page-initialization-action'
import {
  clearBrowserPageDeferredNavigation,
  consumeBrowserPageDeferredNavigation,
  deferBrowserPageNavigation,
  hasBrowserPageInitializationAction
} from './browser-page-deferred-navigation'

import {
  PLACEMENT,
  WS,
  snapshot,
  response,
  publish,
  page
} from './browser-page-initialization-fixture'

installFrameOrderingHarness()
function submitter() {
  const requests: Promise<void>[] = []
  const hook = renderHook(() =>
    useClientHostedPageUrlSubmission({
      browserTabId: 'page-a',
      worktreeId: WT,
      webviewRef: { current: null },
      activeLoadFailureRef: { current: null },
      setAddressBarValue: () => {},
      onSetUrl: (_id, url) =>
        useAppStore.setState((s) => ({
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [WS]: [{ ...s.browserPagesByWorkspace[WS][0], url }]
          }
        })),
      onUpdatePageState: () => {},
      onInitializationAction: (action) => {
        requests.push(
          routeBrowserPageInitializationAction({
            pageId: 'page-a',
            workspaceId: WS,
            worktreeId: WT,
            environmentId: ENV,
            placement: PLACEMENT,
            action
          })
        )
      }
    })
  )
  return { submit: (url: string) => act(() => hook.result.current(url)), requests, hook }
}

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
  resetBrowserClientHostIdForTests()
  clearBrowserPageDeferredNavigation('page-a')
  Object.assign(window.api, { browser: { readClientHostId: () => 'host-a' } })
  useAppStore.setState({ tabsByWorktree: {}, terminalLayoutsByTabId: {}, ptyIdsByTabId: {} })
  await publish(snapshot('https://example.internal/S', 1))
})

it('keeps the typed address through an older frame, settles the action reply and adopts the requested commit', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => answer.promise)
  const h = submitter()
  deferBrowserPageNavigation('page-a', 'https://example.internal/obsolete')
  h.submit('https://example.internal/F')
  expect(consumeBrowserPageDeferredNavigation('page-a')).toBeNull()
  await publish(snapshot('https://example.internal/S', 2))
  expect(page()?.url).toBe('https://example.internal/F')
  answer.resolve(response(snapshot('https://example.internal/F', 3)))
  await act(async () => {
    await h.requests[0]
  })
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
  expect(page()?.url).toBe('https://example.internal/F')
  await publish(snapshot('https://example.internal/redirected', 4, null))
  expect(page()?.url).toBe('https://example.internal/redirected')
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBeUndefined()
  expect(runtimeCall).toHaveBeenCalledTimes(1)
})

it('keeps a newer local submission when the first reply arrives late', async () => {
  const first = Promise.withResolvers<unknown>(),
    second = Promise.withResolvers<unknown>()
  runtimeCall
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  const h = submitter()
  h.submit('https://example.internal/F')
  h.submit('https://example.internal/G')
  first.resolve(response(snapshot('https://example.internal/F', 2)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/G')
  expect(hasBrowserPageInitializationAction('page-a')).toBe(true)
  second.resolve(response(snapshot('https://example.internal/G', 3)))
  await act(async () => {
    await h.requests[1]
  })
  expect(page()?.url).toBe('https://example.internal/G')
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
  expect(runtimeCall).toHaveBeenCalledTimes(2)
})

it('accepts the current address in the action reply and rejects an older frame received before the action but applied after it', async () => {
  const oldReceipt = nextReceivedSessionTabsFrame()
  const answer = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => answer.promise)
  const h = submitter()
  h.submit('https://example.internal/F')
  answer.resolve(response(snapshot('https://example.internal/H', 3)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/H')
  await publish(snapshot('https://example.internal/S', 2), oldReceipt)
  expect(page()?.url).toBe('https://example.internal/H')
  expect(runtimeCall).toHaveBeenCalledTimes(1)
})

it('discards an action reply after its runtime environment is retired', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => answer.promise)
  const h = submitter()
  h.submit('https://example.internal/F')
  replaceRuntimeEnvironmentRevisions([])
  answer.resolve(response(snapshot('https://example.internal/H', 3)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/F')
  expect(page()?.loadError).toBeNull()
  expect(runtimeCall).toHaveBeenCalledTimes(1)
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
})

it('reconciles a newer remote address already received before the delayed action reply', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall
    .mockImplementationOnce(() => answer.promise)
    .mockImplementation(async () => response(snapshot('https://example.internal/H', 3)))
  const h = submitter()
  h.submit('https://example.internal/F')
  await publish(snapshot('https://example.internal/H', 3))
  expect(page()?.url).toBe('https://example.internal/F')
  answer.resolve(response(snapshot('https://example.internal/F', 2)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/H')
  expect(runtimeCall).toHaveBeenCalledTimes(2)
  expect(runtimeCall.mock.calls[1][0]).toMatchObject({ method: 'session.tabs.list' })
  await publish(snapshot('https://example.internal/S', 1))
  expect(page()?.url).toBe('https://example.internal/H')
})

it.each(['settle', 'new-native'] as const)(
  'reconciles a committed redirect before its delayed acceptance without replacing %s native content',
  async (mode) => {
    const answer = Promise.withResolvers<unknown>()
    const read = Promise.withResolvers<unknown>()
    const reading = Promise.withResolvers<void>()
    const committed = snapshot('https://example.internal/R', 3, null)
    committed.tabs = committed.tabs.map((tab) =>
      tab.type === 'browser' ? { ...tab, placement: { ...PLACEMENT, pageHostGeneration: 1 } } : tab
    )
    runtimeCall
      .mockImplementationOnce(() => answer.promise)
      .mockImplementationOnce(() => {
        reading.resolve()
        return read.promise
      })
    const h = submitter()
    h.submit('https://example.internal/F')
    h.hook.unmount()
    await publish(committed)
    expect(page()?.url).toBe('https://example.internal/F')
    answer.resolve(response(snapshot('https://example.internal/F', 2)))
    await act(async () => {
      await reading.promise
    })
    expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
    if (mode === 'new-native') {
      act(() =>
        useAppStore.setState((state) => ({
          browserPagesByWorkspace: {
            ...state.browserPagesByWorkspace,
            [WS]: [
              {
                ...state.browserPagesByWorkspace[WS][0],
                url: 'https://example.internal/N',
                title: 'New native document',
                loading: false
              }
            ]
          }
        }))
      )
    }
    read.resolve(response(committed))
    await act(async () => {
      await h.requests[0]
    })
    expect(page()?.url).toBe(
      mode === 'settle' ? 'https://example.internal/R' : 'https://example.internal/N'
    )
    expect(runtimeCall.mock.calls.map(([call]) => call.method)).toEqual([
      'browser.clientPage.initializationAction',
      'session.tabs.list'
    ])
  }
)

it('clears a failed action with one current read and never revives a removed page', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall
    .mockImplementationOnce(() => answer.promise)
    .mockImplementation(async () => response(snapshot('https://example.internal/S', 1)))
  const h = submitter()
  h.submit('https://example.internal/F')
  answer.reject(new Error('unavailable'))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.loadError).toBeNull()
  expect(page()?.url).toBe('https://example.internal/S')
  expect(runtimeCall).toHaveBeenCalledTimes(2)
  const removed = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => removed.promise)
  h.submit('https://example.internal/G')
  await publish({ ...snapshot('', 4), tabs: [] })
  removed.resolve(response(snapshot('https://example.internal/G', 3)))
  await act(async () => {
    await h.requests[1]
  })
  expect(page()).toBeUndefined()
  expect(runtimeCall).toHaveBeenCalledTimes(3)
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
})

it('carries transient initialization through the actual delta codec, clears omission and excludes it from disk', async () => {
  const encoder = createSessionTabsTabDeltaEncoder([SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY])
  const decoder = createSessionTabsTabDeltaDecoder()
  const first = snapshot('https://example.internal/S', 2)
  // Include an unchanged sibling so the production codec chooses its delta branch.
  const sibling = first.tabs[0]
  if (sibling.type !== 'browser') {
    throw new Error('browser_fixture_required')
  }
  first.tabs.push({
    ...sibling,
    id: 'tab-b',
    browserPageId: 'page-b',
    browserWorkspaceId: 'workspace-b'
  })
  const encoded = decoder.decode(
    JSON.parse(JSON.stringify(encoder.full({ ...first, type: 'snapshot' })))
  )
  expect(encoded.ok).toBe(true)
  const cleared = {
    ...first,
    snapshotVersion: 3,
    tabs: first.tabs.map((tab, index) =>
      index === 0 ? { ...tab, initializationState: undefined, loading: false } : tab
    )
  }
  const wire = encoder.update({ ...cleared, type: 'updated' })
  expect(wire).toHaveProperty('tabsDelta')
  const decoded = decoder.decode(JSON.parse(JSON.stringify(wire)))
  expect(decoded.ok).toBe(true)
  if (!decoded.ok) {
    throw new Error('fixture delta failed')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: codec roundtrips the typed frame above; its public result stays unknown.
  await publish(decoded.result as RuntimeMobileSessionTabsResult)
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBeUndefined()
  await publish(snapshot('https://example.internal/S', 4, 'stopped'))
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('stopped')
  const state = useAppStore.getState()
  const saved = buildPersistedBrowserPagesByWorkspace(
    state.browserPagesByWorkspace,
    state.remoteBrowserPageHandlesByPageId,
    {}
  )
  expect(saved?.[WS]?.[0]).not.toHaveProperty('initializationState')
})

it('rejects old action and dispatched read across loss without changing fresh pending or its requested address', async () => {
  const oldAction = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => oldAction.promise)
  const h = submitter()
  h.submit('https://example.internal/typed')
  const read = Promise.withResolvers<{
    snapshot: RuntimeMobileSessionTabsResult
    runtimeId: string
  }>()
  const dispatched = listRemoteRuntimeSessionTabsDeduped({
    environmentId: ENV,
    worktreeId: WT,
    load: () => read.promise
  })
  act(() =>
    diagnostics({
      environmentId: ENV,
      transportGeneration: 1,
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
  )
  await publish(snapshot('https://example.internal/fresh', 4))
  oldAction.reject(new Error('transport closed'))
  read.resolve({
    snapshot: snapshot('https://example.internal/obsolete', 100, null),
    runtimeId: 'runtime-a'
  })
  await act(async () => {
    await h.requests[0]
    await applyWebRuntimeSessionTabsAnswer(ENV, WT, await dispatched)
  })
  expect(page()?.url).toBe('https://example.internal/fresh')
  expect(page()?.loadError).toBeNull()
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('pending')
  expect(runtimeCall).toHaveBeenCalledTimes(1)
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
})

it('keeps cached pending revoked until a fresh equal-version replay is accepted', async () => {
  const cached = snapshot('https://example.internal/S', 2)
  await publish(cached)
  const emit = (state: 'closed' | 'ready') =>
    act(() =>
      diagnostics({
        environmentId: ENV,
        transportGeneration: 1,
        diagnostics: {
          state,
          pendingRequestCount: 0,
          subscriptionCount: 1,
          reconnectAttempt: 0,
          lastConnectedAt: 1,
          lastClose: null,
          lastError: null
        }
      })
    )
  emit('closed')
  emit('ready')
  await publish(cached)
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('unavailable')
  await act(async () => {
    await applyWebRuntimeSessionTabsAnswer(
      ENV,
      WT,
      {
        snapshot: snapshot('https://example.internal/S', 2),
        receivedFrame: nextReceivedSessionTabsFrame(),
        runtimeId: 'runtime-a'
      },
      { acceptCurrentSnapshot: true }
    )
  })
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('pending')
  expect(page()?.url).toBe('https://example.internal/S')
})

it.each([10, 100])(
  'keeps held presentation stable over %s unrelated received frames and still publishes Stop',
  async (count) => {
    vi.useFakeTimers()
    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    const persist = vi.fn()
    const stopPersistence = createSessionWriteSubscriber({ store: useAppStore, persist })
    await vi.advanceTimersByTimeAsync(200)
    persist.mockClear()
    const render = vi.fn()
    const hook = renderHook(() => {
      const presentation = useAppStore(
        (s) => s.remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      )
      render()
      return presentation?.disposition
    })
    render.mockClear()
    const handles = useAppStore.getState().remoteBrowserPageHandlesByPageId
    let handleWrites = 0
    const unsubscribe = useAppStore.subscribe((s, previous) => {
      if (s.remoteBrowserPageHandlesByPageId !== previous.remoteBrowserPageHandlesByPageId) {
        handleWrites++
      }
    })
    try {
      for (let i = 0; i < count; i++) {
        await publish(snapshot('https://example.internal/S', i + 2))
        await vi.advanceTimersByTimeAsync(200)
      }
      expect(useAppStore.getState().remoteBrowserPageHandlesByPageId).toBe(handles)
      expect(handleWrites).toBe(0)
      expect(render).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
      await publish(snapshot('https://example.internal/S', count + 2, 'stopped'))
      expect(handleWrites).toBe(1)
      expect(hook.result.current).toBe('stopped')
      await vi.advanceTimersByTimeAsync(200)
      expect(persist).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      hook.unmount()
      stopPersistence()
      vi.useRealTimers()
    }
  }
)

it('does not reauthorize pending from a retired-publisher census dispatched before loss', async () => {
  const coordinator = new VisibilityResumeCoordinator({
    environments: [],
    environmentIdBySubscriptionSpec: [],
    omissions: new Map(),
    activeRuntimeWorktreeKey: () => null
  })
  const globalFrame = async (epoch: string, version: number) => {
    await act(async () => {
      handleGlobalSessionEvent({
        environmentId: ENV,
        expectedEnvironmentConnectionGeneration: 1,
        expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(ENV),
        expectedTrackingGeneration: getWebSessionTabsTrackingGeneration(ENV),
        visibilityGeneration: 0,
        isCurrent: () => true,
        event: {
          ...snapshot('https://example.internal/S', version),
          publicationEpoch: epoch,
          type: 'snapshot'
        },
        response: response({
          ...snapshot('https://example.internal/S', version),
          publicationEpoch: epoch
        }),
        awaitingVisibilityResumeInventory: { value: false },
        coordinator
      })
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  vi.useFakeTimers()
  try {
    await globalFrame('epoch-b', 1)
    await globalFrame('epoch-a', 2)
    const census = Promise.withResolvers<unknown>()
    runtimeCall.mockImplementationOnce(() => census.promise)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.listAll' })
    )
    act(() =>
      diagnostics({
        environmentId: ENV,
        transportGeneration: 1,
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
    )
    await act(async () => {
      census.resolve({
        id: 'census',
        ok: true,
        result: { authoritative: true, snapshots: [snapshot('https://example.internal/S', 3)] },
        _meta: { runtimeId: 'runtime-a' }
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(
      useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
        ?.disposition
    ).toBe('unavailable')
    await globalFrame('epoch-c', 1)
    expect(
      useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
        ?.disposition
    ).toBe('pending')
  } finally {
    vi.useRealTimers()
  }
})

it('does not persist delivery presentation but still saves changed browser ownership and staged visibility', async () => {
  vi.useFakeTimers()
  useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
  const persist = vi.fn()
  const stop = createSessionWriteSubscriber({ store: useAppStore, persist })
  try {
    await vi.advanceTimersByTimeAsync(200)
    persist.mockClear()
    act(() =>
      diagnostics({
        environmentId: ENV,
        transportGeneration: 1,
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
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).not.toHaveBeenCalled()
    await publish(snapshot('https://example.internal/S', 2))
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).not.toHaveBeenCalled()
    const updateHandle = (patch: Partial<RemoteBrowserPageHandle>) => {
      useAppStore.setState((s) => ({
        remoteBrowserPageHandlesByPageId: Object.assign(
          copyBrowserPageHandles(s.remoteBrowserPageHandlesByPageId, ['page-a']),
          {
            'page-a': { ...s.remoteBrowserPageHandlesByPageId['page-a'], ...patch }
          }
        )
      }))
    }
    updateHandle({ remotePageId: 'replacement-identity' })
    await vi.advanceTimersByTimeAsync(200)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.browserPagesByWorkspace[WS][0]).toMatchObject({
      url: 'https://example.internal/S',
      remoteBrowserPageId: 'replacement-identity',
      remoteBrowserPageClientHosted: true
    })
    persist.mockClear()
    updateHandle({ staged: true })
    await vi.advanceTimersByTimeAsync(200)
    expect(persist.mock.calls[0][0].patch.browserPagesByWorkspace[WS]).toBeUndefined()
    persist.mockClear()
    updateHandle({ staged: undefined })
    await vi.advanceTimersByTimeAsync(200)
    expect(persist.mock.calls[0][0].patch.browserPagesByWorkspace[WS][0].remoteBrowserPageId).toBe(
      'replacement-identity'
    )
  } finally {
    stop()
    vi.useRealTimers()
  }
})
