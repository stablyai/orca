import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({}) }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/components/browser-pane/describe-page/live-browser-url-registry', () => ({
  rememberLiveBrowserUrl: vi.fn()
}))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))

import { isBrowserAutomationVisible } from '@/components/browser-pane/host-guest/browser-automation-visibility'
import { registerBrowserStateIpcBridge } from './browser-state-ipc-bridge'

type CapturePaintHoldEvent = { browserPageId: string; held: boolean }

function captureHoldHandler(unsubs: (() => void)[] = []): (event: CapturePaintHoldEvent) => void {
  let handler: ((event: CapturePaintHoldEvent) => void) | null = null
  const subscribe = vi.fn(() => () => {})
  vi.stubGlobal('window', {
    api: {
      ui: { onFullscreenChanged: subscribe },
      browser: {
        onGuestLoadFailed: subscribe,
        onNavigationUpdate: subscribe,
        onActivateView: subscribe,
        onPaneFocus: subscribe,
        onOpenLinkInOrcaTab: subscribe,
        onCapturePaintHold: (callback: (event: CapturePaintHoldEvent) => void) => {
          handler = callback
          return () => {}
        }
      }
    }
  })

  registerBrowserStateIpcBridge(unsubs, () => false)
  if (!handler) {
    throw new Error('Expected the bridge to subscribe to browser:capturePaintHold')
  }
  return handler
}

describe('capture paint holds from main', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the page drawn from the hold until its release, ignoring repeats', () => {
    const onHold = captureHoldHandler()

    onHold({ browserPageId: 'page-1', held: true })
    onHold({ browserPageId: 'page-1', held: true })
    expect(isBrowserAutomationVisible('page-1')).toBe(true)

    onHold({ browserPageId: 'page-1', held: false })
    expect(isBrowserAutomationVisible('page-1')).toBe(false)

    onHold({ browserPageId: 'page-1', held: false })
    expect(isBrowserAutomationVisible('page-1')).toBe(false)
  })

  it('releases a live hold when the bridge is disposed', () => {
    const unsubs: (() => void)[] = []
    const onHold = captureHoldHandler(unsubs)

    onHold({ browserPageId: 'page-2', held: true })
    expect(isBrowserAutomationVisible('page-2')).toBe(true)

    for (const unsubscribe of unsubs) {
      unsubscribe()
    }
    expect(isBrowserAutomationVisible('page-2')).toBe(false)
  })
})
