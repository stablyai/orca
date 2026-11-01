import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({}) }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
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
type AgentActivityEvent = { browserPageId: string; worktreeId: string | null; active: boolean }

function registerBridge(unsubs: (() => void)[] = []): {
  onHold: (event: CapturePaintHoldEvent) => void
  onAgentActivity: (event: AgentActivityEvent) => void
} {
  let onHold: ((event: CapturePaintHoldEvent) => void) | null = null
  let onAgentActivity: ((event: AgentActivityEvent) => void) | null = null
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
        onSessionProfilesChanged: subscribe,
        onCapturePaintHold: (callback: (event: CapturePaintHoldEvent) => void) => {
          onHold = callback
          return () => {}
        },
        onAgentActivity: (callback: (event: AgentActivityEvent) => void) => {
          onAgentActivity = callback
          return () => {}
        }
      }
    }
  })

  registerBrowserStateIpcBridge(unsubs, () => false)
  if (!onHold || !onAgentActivity) {
    throw new Error('Expected the bridge to subscribe to capture holds and agent activity')
  }
  return { onHold, onAgentActivity }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('capture paint holds from main', () => {
  it('keeps the page drawn from the hold until its release, ignoring repeats', () => {
    const { onHold } = registerBridge()

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
    const { onHold } = registerBridge(unsubs)

    onHold({ browserPageId: 'page-2', held: true })
    expect(isBrowserAutomationVisible('page-2')).toBe(true)

    for (const unsubscribe of unsubs) {
      unsubscribe()
    }
    expect(isBrowserAutomationVisible('page-2')).toBe(false)
  })
})

describe('agent activity from main', () => {
  // #36161: a fixed bootstrap lease let a driven page in a hidden worktree stop drawing.
  it('keeps the page drawn while an agent drives it, until main reports it idle', () => {
    const { onAgentActivity } = registerBridge()

    onAgentActivity({ browserPageId: 'page-3', worktreeId: 'wt-agent', active: true })
    onAgentActivity({ browserPageId: 'page-3', worktreeId: 'wt-agent', active: true })
    expect(isBrowserAutomationVisible('page-3')).toBe(true)

    onAgentActivity({ browserPageId: 'page-3', worktreeId: 'wt-agent', active: false })
    expect(isBrowserAutomationVisible('page-3')).toBe(false)
  })
})
