// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTab as BrowserTabState } from '../../../shared/browser-workspace-types'

type MockAppState = { browserTabsByWorktree: Record<string, readonly BrowserTabState[]> }

const mocks = vi.hoisted(() => ({ state: null as MockAppState | null }))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

// Use real driver/lease modules to exercise the paint-retention wiring.
const { setDriverForBrowserPage } = await import('../lib/pane-manager/browser-mobile-driver-state')
const { acquireBrowserAutomationVisibility, releaseBrowserAutomationVisibility } =
  await import('./browser-pane/host-guest/browser-automation-visibility')
const { TerminalWorkbenchContainer } = await import('./TerminalWorkbenchContainer')

const PAGE_ID = 'page-1'

function mountWorkbench(isVisible: boolean): HTMLElement {
  mocks.state = {
    browserTabsByWorktree: {
      'wt-1': [{ id: 'tab-1', activePageId: PAGE_ID }] as unknown as readonly BrowserTabState[]
    }
  }
  const { container } = render(
    <TerminalWorkbenchContainer isVisible={isVisible}>
      <span>workbench</span>
    </TerminalWorkbenchContainer>
  )
  const node = container.querySelector('[data-terminal-workbench-container]')
  if (!(node instanceof HTMLElement)) {
    throw new Error('workbench container not rendered')
  }
  return node
}

afterEach(() => {
  cleanup()
  setDriverForBrowserPage(PAGE_ID, { kind: 'idle' })
  mocks.state = null
})

describe('TerminalWorkbenchContainer', () => {
  it('parks with display:none when nothing remote needs the guest painting', () => {
    expect(mountWorkbench(false).className).toContain('hidden')
  })

  it('renders normally on the workspace view', () => {
    const node = mountWorkbench(true)
    expect(node.className).not.toContain('hidden')
    expect(node.className).not.toContain('opacity-0')
    expect(node.hasAttribute('inert')).toBe(false)
  })

  // display:none stops Chromium screencasts, freezing phone browsers on Settings.
  it('never applies display:none while a phone drives one of its pages', () => {
    setDriverForBrowserPage(PAGE_ID, { kind: 'mobile', clientId: 'client-1' })
    const node = mountWorkbench(false)
    expect(node.className).not.toContain('hidden')
    expect(node.className).toContain('opacity-0')
  })

  // Bootstrap leases must permit guest mounting before screencasts can register a mobile driver.
  it('never applies display:none while an automation lease holds one of its pages', () => {
    const token = acquireBrowserAutomationVisibility(PAGE_ID)
    try {
      const node = mountWorkbench(false)
      expect(node.className).not.toContain('hidden')
      expect(node.className).toContain('opacity-0')
    } finally {
      releaseBrowserAutomationVisibility(token)
    }
  })

  it('stays out of flow and non-interactive while painting hidden', () => {
    // Invisible workbenches must neither shrink the active page nor intercept its clicks.
    setDriverForBrowserPage(PAGE_ID, { kind: 'mobile', clientId: 'client-1' })
    const node = mountWorkbench(false)
    expect(node.className).toContain('absolute')
    expect(node.className).toContain('pointer-events-none')
    expect(node.hasAttribute('inert')).toBe(true)
    expect(node.getAttribute('aria-hidden')).toBe('true')
  })

  it('mounts parked after the phone driver is cleared', () => {
    setDriverForBrowserPage(PAGE_ID, { kind: 'mobile', clientId: 'client-1' })
    expect(mountWorkbench(false).className).not.toContain('hidden')
    cleanup()
    setDriverForBrowserPage(PAGE_ID, { kind: 'idle' })
    expect(mountWorkbench(false).className).toContain('hidden')
  })
})
