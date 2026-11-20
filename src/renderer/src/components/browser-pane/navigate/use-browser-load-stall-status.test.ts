// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { BrowserLoadStallEvent } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { registerBrowserStateIpcBridge } from '../../../hooks/ipc-events/browser/browser-state-ipc-bridge'
import { useBrowserLoadStallStatus } from './use-browser-load-stall-status'

afterEach(() => {
  cleanup()
})

it('shows a stall reported after app launch but before any status bubble mounted', () => {
  const port: { deliver?: (event: BrowserLoadStallEvent) => void } = {}
  // Every bridge subscription is a no-op except the load-stall one under test.
  const methods = new Proxy(
    {},
    {
      get: (_target, method) =>
        method === 'onLoadStall'
          ? (callback: (event: BrowserLoadStallEvent) => void) => {
              port.deliver = callback
              return () => {}
            }
          : () => () => {}
    }
  )
  Object.assign(window, { api: new Proxy({}, { get: () => methods }) })
  const unsubs: (() => void)[] = []
  registerBrowserStateIpcBridge(unsubs, () => false)
  // A retained page stalls while no browser pane is open.
  const deliver = (event: BrowserLoadStallEvent): void => port.deliver?.(event)
  deliver({
    browserPageId: 'page-1',
    webContentsId: 7,
    stall: { host: 'localhost:3000' }
  })
  const { result } = renderHook(() => useBrowserLoadStallStatus('page-1'))
  expect(result.current).toContain('localhost:3000')
  // Tearing the app down (e.g. its error fallback) can miss the clear, so the cached stall goes.
  act(() => {
    for (const unsubscribe of unsubs) {
      unsubscribe()
    }
  })
  expect(result.current).toBeNull()
})
