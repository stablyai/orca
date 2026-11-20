// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { BrowserLoadStallEvent } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import {
  listenForBrowserLoadStalls,
  useBrowserLoadStallStatus
} from './use-browser-load-stall-status'

afterEach(() => {
  cleanup()
})

it('shows a stall reported before any status bubble mounted', () => {
  const port: { deliver?: (event: BrowserLoadStallEvent) => void } = {}
  Object.assign(window, {
    api: {
      browser: {
        onLoadStall: (callback: (event: BrowserLoadStallEvent) => void) => {
          port.deliver = callback
          return () => {
            port.deliver = undefined
          }
        }
      }
    }
  })
  // App launch subscribes; a retained page then stalls while no browser pane is open.
  const stop = listenForBrowserLoadStalls()
  const deliver = (event: BrowserLoadStallEvent): void => port.deliver?.(event)
  deliver({
    browserPageId: 'page-1',
    webContentsId: 7,
    stall: { phase: 'sent', host: 'localhost:3000', hiddenSameOriginPages: 0 }
  })
  const { result } = renderHook(() => useBrowserLoadStallStatus('page-1'))
  expect(result.current).toContain('localhost:3000')
  stop()
})
