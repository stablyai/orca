// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAutomationActivityEvent } from '../../../../shared/browser-automation-activity'
import {
  clearBrowserAutomationActivity,
  isBrowserAutomationActive
} from '@/lib/browser-automation-activity'
import { registerBrowserAutomationActivityIpcBridge } from './browser-automation-activity-ipc-bridge'

describe('browser automation IPC subscription', () => {
  afterEach(() => {
    clearBrowserAutomationActivity()
    vi.unstubAllGlobals()
  })

  it('accepts page activity and clears it when the owning subscription is removed', () => {
    let receive: ((event: BrowserAutomationActivityEvent) => void) | undefined
    const unsubscribe = vi.fn()
    vi.stubGlobal('window', {
      api: {
        browser: {
          onAutomationActivity: (callback: (event: BrowserAutomationActivityEvent) => void) => {
            receive = callback
            return unsubscribe
          }
        }
      }
    })
    const unsubs: (() => void)[] = []
    registerBrowserAutomationActivityIpcBridge(unsubs)
    receive?.({
      browserPageId: 'page-a',
      token: 'token-a',
      active: true,
      expiresAt: Date.now() + 30_000
    })
    expect(isBrowserAutomationActive('page-a')).toBe(true)
    unsubs[0]()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(isBrowserAutomationActive('page-a')).toBe(false)
  })

  it('remains compatible with a preload without the optional event', () => {
    vi.stubGlobal('window', { api: { browser: {} } })
    const unsubs: (() => void)[] = []
    expect(() => registerBrowserAutomationActivityIpcBridge(unsubs)).not.toThrow()
    expect(unsubs).toEqual([])
  })
})
