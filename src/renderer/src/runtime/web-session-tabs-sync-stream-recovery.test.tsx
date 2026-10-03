// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type * as WebSessionTerminalHandleEventsModule from './web-session-terminal-handle-events'

vi.mock('./web-session-terminal-handle-events', async (importOriginal) => {
  const actual = await importOriginal<typeof WebSessionTerminalHandleEventsModule>()
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return {
    ...actual,
    queueAcceptedWebSessionTerminalSnapshot: frameOrderingMocks.queueAcceptedSnapshot
  }
})
vi.mock('./use-runtime-session-mirror-environment-key', async () => {
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return {
    useRuntimeSessionMirrorEnvironmentKey: frameOrderingMocks.runtimeSessionMirrorEnvironmentKey
  }
})
vi.mock('./web-session-terminal-orphan-recovery', async () => {
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { recoverWebSessionTerminalOrphansBeforeApply: frameOrderingMocks.recoverSnapshot }
})

import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { makeHostSnapshot, WT } from './host-session-mirror-frame-fixtures'
import {
  findSubscription,
  installFrameOrderingHarness,
  publish,
  runtimeSubscribe,
  settle,
  subscriptions,
  tabIds
} from './host-session-mirror-frame-ordering-harness'
import { useWebSessionTabsSync } from './web-session-tabs-sync'

const METHODS = ['session.tabs.subscribeAll', 'session.tabs.subscribe'] as const

describe('session tab stream recovery', () => {
  installFrameOrderingHarness({ fakeTimers: true })

  it.each(METHODS)(
    '%s applies newly created tabs after a terminal stream close',
    async (method) => {
      renderHook(() => useWebSessionTabsSync())
      await act(settle)
      const original = findSubscription(method)
      await act(async () => {
        original.callbacks.onClose?.()
        await vi.advanceTimersByTimeAsync(1_250)
      })
      const replacement = findSubscription(method, 1)
      const snapshot = makeHostSnapshot(WT, 'new-tab::new-leaf', 'new-tab')
      await publish(
        replacement,
        method === 'session.tabs.subscribeAll'
          ? { type: 'snapshots', snapshots: [snapshot] }
          : { type: 'snapshot', ...snapshot }
      )
      expect(tabIds(WT)).toContain(toWebTerminalSurfaceTabId('new-tab'))
      await publish(original, { type: 'updated', ...snapshot, snapshotVersion: 2, tabs: [] })
      expect(tabIds(WT)).toContain(toWebTerminalSurfaceTabId('new-tab'))
    }
  )

  it.each(METHODS)(
    '%s retries an ended or rejected stream without a visibility change',
    async (method) => {
      renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await publish(findSubscription(method), { type: 'end' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_250)
      })
      const replacement = findSubscription(method, 1)
      await act(async () => {
        replacement.callbacks.onResponse({
          id: 'failed-subscription',
          ok: false,
          error: { code: 'internal_error', message: 'Inventory temporarily unavailable' }
        })
        await vi.advanceTimersByTimeAsync(1_250)
      })
      expect(findSubscription(method, 2)).toBeDefined()
    }
  )

  it('recovers when close arrives before the subscription handle resolves', async () => {
    runtimeSubscribe.mockImplementationOnce(async (request, callbacks) => {
      subscriptions.push({ request, callbacks })
      callbacks.onClose?.()
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    renderHook(() => useWebSessionTabsSync())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250)
    })
    expect(findSubscription('session.tabs.subscribeAll', 1)).toBeDefined()
  })

  it('leaves transient transport errors to shared-control replay and cancels retry on unmount', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const original = findSubscription('session.tabs.subscribeAll')
    await act(async () => {
      original.callbacks.onError?.({ code: 'disconnected', message: 'Reconnecting' })
      await vi.advanceTimersByTimeAsync(1_250)
    })
    expect(subscriptions).toHaveLength(2)
    original.callbacks.onClose?.()
    hook.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(subscriptions).toHaveLength(2)
  })
})
