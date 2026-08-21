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

// Why: the driver and automation-lease modules are the real ones — mocking them would leave
// the wiring under test unproven, which is the whole point of this file.
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

  // Why: `hidden` is display:none, and Chromium emits no screencast frames from inside such a
  // subtree — this is the exact regression that froze a phone's browser pane on Settings.
  it('never applies display:none while a phone drives one of its pages', () => {
    setDriverForBrowserPage(PAGE_ID, { kind: 'mobile', clientId: 'client-1' })
    const node = mountWorkbench(false)
    expect(node.className).not.toContain('hidden')
    expect(node.className).toContain('opacity-0')
  })

  // Why: the cold-start deadlock. A screencast cannot start until the guest registers, and the
  // guest only mounts under an automation bootstrap lease — gating on the mobile driver alone
  // means the guest never mounts, so the driver never flips.
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
    // Why: the active page is a flex sibling — an in-flow workbench would halve its height,
    // and a hittable one would swallow its clicks.
    setDriverForBrowserPage(PAGE_ID, { kind: 'mobile', clientId: 'client-1' })
    const node = mountWorkbench(false)
    expect(node.className).toContain('absolute')
    expect(node.className).toContain('pointer-events-none')
    expect(node.hasAttribute('inert')).toBe(true)
    expect(node.getAttribute('aria-hidden')).toBe('true')
  })

  it('re-parks once the phone stops driving the page', () => {
    setDriverForBrowserPage(PAGE_ID, { kind: 'mobile', clientId: 'client-1' })
    expect(mountWorkbench(false).className).not.toContain('hidden')
    cleanup()
    setDriverForBrowserPage(PAGE_ID, { kind: 'idle' })
    expect(mountWorkbench(false).className).toContain('hidden')
  })
})
