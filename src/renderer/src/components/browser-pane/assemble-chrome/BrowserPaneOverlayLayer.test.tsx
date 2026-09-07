// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { Suspense } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTab as BrowserTabState } from '../../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'

type MockAppState = {
  browserTabsByWorktree: Record<string, readonly BrowserTabState[]>
  unifiedTabsByWorktree: Record<string, readonly Tab[]>
  groupsByWorktree: Record<string, readonly TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  focusGroup: (worktreeId: string, groupId: string) => void
}

const mocks = vi.hoisted(() => ({
  state: null as MockAppState | null,
  automationVisiblePageIds: new Set<string>(),
  mobileDrivenPageIds: new Set<string>(),
  remotelyViewedPageIds: new Set<string>(),
  focusGroup: vi.fn()
}))

vi.mock('../../../store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

vi.mock('../host-guest/browser-automation-visibility', () => ({
  useBrowserAutomationVisibilityForAny: (pageIds: readonly string[]) =>
    pageIds.some((pageId) => mocks.automationVisiblePageIds.has(pageId))
}))

vi.mock('@/lib/pane-manager/browser-mobile-driver-state', () => ({
  useBrowserMobileDriverForAny: (pageIds: readonly string[]) =>
    pageIds.some((pageId) => mocks.mobileDrivenPageIds.has(pageId))
}))

vi.mock('@/lib/pane-manager/browser-remote-viewer-state', () => ({
  useBrowserRemoteViewerForAny: (pageIds: readonly string[]) =>
    pageIds.some((pageId) => mocks.remotelyViewedPageIds.has(pageId))
}))

vi.mock('./browser-workspace-pane', () => ({
  default: ({
    browserTab,
    isActive,
    chromeShortcutScope
  }: {
    browserTab: BrowserTabState
    isActive: boolean
    chromeShortcutScope?: string
  }) => (
    <span
      data-browser-pane-id={browserTab.id}
      data-browser-pane-active={isActive ? 'true' : 'false'}
      data-browser-find-shortcut-scope={chromeShortcutScope}
    />
  )
}))

import {
  applyClientHostedBrowserRows,
  clearClientHostedBrowserRowSelection,
  selectClientHostedBrowserRow
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import BrowserPaneOverlayLayer, { RetainedBrowserPaneOverlayLayer } from './BrowserPaneOverlayLayer'

const HOST_ROW = {
  browserPageId: 'page-hosted',
  worktreeId: 'wt-1',
  url: 'https://example.test/hosted',
  title: 'Hosted',
  loading: false,
  browserHostClientId: 'host-a',
  hostDeviceName: 'Studio',
  hostAbsent: false
}

describe('BrowserPaneOverlayLayer', () => {
  beforeEach(() => {
    mocks.automationVisiblePageIds.clear()
    mocks.mobileDrivenPageIds.clear()
    mocks.remotelyViewedPageIds.clear()
    mocks.focusGroup.mockClear()
    mocks.state = createState()
  })

  afterEach(() => {
    cleanup()
    // The row store is module-level, so a leftover row would render an extra pane in every
    // sibling test.
    clearClientHostedBrowserRowSelection()
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [] })
  })

  it('defers browser slots for a restricted hidden mount, then retains them after activation', () => {
    const view = render(
      <RetainedBrowserPaneOverlayLayer
        worktreeId="wt-1"
        isWorktreeActive={false}
        mountEligible={false}
      />
    )

    expect(view.container.querySelectorAll('[data-browser-overlay-tab-id]')).toHaveLength(0)

    view.rerender(
      <RetainedBrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive mountEligible />
    )
    expect(view.container.querySelectorAll('[data-browser-overlay-tab-id]')).toHaveLength(2)

    view.rerender(
      <RetainedBrowserPaneOverlayLayer
        worktreeId="wt-1"
        isWorktreeActive={false}
        mountEligible={false}
      />
    )
    expect(view.container.querySelectorAll('[data-browser-overlay-tab-id]')).toHaveLength(2)
  })

  it('discards the retained latch when the worktree surface unmounts', () => {
    const view = render(
      <RetainedBrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive mountEligible />
    )
    expect(view.container.querySelectorAll('[data-browser-overlay-tab-id]')).toHaveLength(2)

    // Worktree removal (or Terminal teardown) unmounts the layer with its surface.
    view.unmount()

    // A remount starts a fresh layer: the latch must reset, deferring until eligible again.
    const revisit = render(
      <RetainedBrowserPaneOverlayLayer
        worktreeId="wt-1"
        isWorktreeActive={false}
        mountEligible={false}
      />
    )
    expect(revisit.container.querySelectorAll('[data-browser-overlay-tab-id]')).toHaveLength(0)

    revisit.rerender(
      <RetainedBrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive mountEligible />
    )
    expect(revisit.container.querySelectorAll('[data-browser-overlay-tab-id]')).toHaveLength(2)
  })

  it('does not retain browser slots from an eligible render that never commits', () => {
    const pending = new Promise<never>(() => {})
    const BlockCommit = ({ blocked }: { blocked: boolean }): null => {
      if (blocked) {
        throw pending
      }
      return null
    }
    const renderBoundary = (mountEligible: boolean, blocked: boolean) => (
      <Suspense fallback={<span data-suspended />}>
        <RetainedBrowserPaneOverlayLayer
          worktreeId="wt-1"
          isWorktreeActive={mountEligible}
          mountEligible={mountEligible}
        />
        <BlockCommit blocked={blocked} />
      </Suspense>
    )
    const view = render(renderBoundary(false, false))

    view.rerender(renderBoundary(true, true))
    expect(view.container.querySelector('[data-suspended]')).not.toBeNull()

    view.rerender(renderBoundary(false, false))
    expect(view.container.querySelectorAll('[data-browser-overlay-tab-id]')).toHaveLength(0)
  })

  it('keeps inactive browser panes mounted for a visible worktree', () => {
    const markup = renderOverlay({ isWorktreeActive: true })

    expect(markup).toContain('data-browser-pane-id="browser-a"')
    expect(markup).toContain('data-browser-pane-active="true"')
    expect(markup).toContain('data-browser-pane-id="browser-b"')
    expect(markup).toContain('data-browser-pane-active="false"')
  })

  it('marks the active browser pane focused when its own group holds focus', () => {
    const markup = renderOverlay({ isWorktreeActive: true })

    // browser-a is the active tab of group-1, and group-1 is the focused split.
    expect(markup).toContain(
      'data-browser-pane-id="browser-a" data-browser-pane-active="true" data-browser-find-shortcut-scope="focused"'
    )
  })

  it('keeps an active browser pane unfocused when another split holds focus (#11348)', () => {
    mocks.state = createState()
    mocks.state.groupsByWorktree = {
      'wt-1': [
        ...mocks.state.groupsByWorktree['wt-1'],
        {
          id: 'group-2',
          worktreeId: 'wt-1',
          activeTabId: null,
          tabOrder: []
        }
      ]
    }
    mocks.state.activeGroupIdByWorktree = { 'wt-1': 'group-2' }

    const markup = renderOverlay({ isWorktreeActive: true })

    expect(markup).toContain(
      'data-browser-pane-id="browser-a" data-browser-pane-active="true" data-browser-find-shortcut-scope="inactive"'
    )
  })

  it('limits Find to the owning target while focused-group state is unavailable', () => {
    mocks.state = createState()
    mocks.state.activeGroupIdByWorktree = {}

    const markup = renderOverlay({ isWorktreeActive: true })

    expect(markup).toContain(
      'data-browser-pane-id="browser-a" data-browser-pane-active="true" data-browser-find-shortcut-scope="owned-target"'
    )
  })

  it('limits Find to the owning target when the focused-group ID is stale', () => {
    mocks.state = createState()
    mocks.state.activeGroupIdByWorktree = { 'wt-1': 'removed-group' }

    const markup = renderOverlay({ isWorktreeActive: true })

    expect(markup).toContain(
      'data-browser-pane-id="browser-a" data-browser-pane-active="true" data-browser-find-shortcut-scope="owned-target"'
    )
  })

  it('keeps Find ownership with group identities after split order changes', () => {
    mocks.state = createState()
    const [tabA, tabB] = mocks.state.unifiedTabsByWorktree['wt-1']
    const [groupA] = mocks.state.groupsByWorktree['wt-1']
    mocks.state.unifiedTabsByWorktree = {
      'wt-1': [{ ...tabB, groupId: 'group-2' }, tabA]
    }
    mocks.state.groupsByWorktree = {
      'wt-1': [
        {
          id: 'group-2',
          worktreeId: 'wt-1',
          activeTabId: tabB.id,
          tabOrder: [tabB.id]
        },
        { ...groupA, tabOrder: [tabA.id] }
      ]
    }

    const markup = renderOverlay({ isWorktreeActive: true })

    expect(markup).toContain(
      'data-browser-pane-id="browser-a" data-browser-pane-active="true" data-browser-find-shortcut-scope="focused"'
    )
    expect(markup).toContain(
      'data-browser-pane-id="browser-b" data-browser-pane-active="true" data-browser-find-shortcut-scope="inactive"'
    )
  })

  it('marks automation-visible inactive browser panes paintable without remounting them', () => {
    mocks.automationVisiblePageIds.add('page-b')

    const markup = renderOverlay({ isWorktreeActive: true })

    expect(markup).toContain('data-browser-pane-id="browser-a"')
    expect(markup).toContain('data-browser-pane-id="browser-b"')
    expect(markup).toContain('data-browser-pane-active="false"')
  })

  it('parks browser panes when their worktree is hidden', () => {
    const markup = renderOverlay({ isWorktreeActive: false })

    expect(markup).not.toContain('data-browser-pane-id="browser-a"')
    expect(markup).not.toContain('data-browser-pane-id="browser-b"')
  })

  it('keeps an automation-visible hidden browser pane mounted', () => {
    mocks.automationVisiblePageIds.add('page-b')

    const markup = renderOverlay({ isWorktreeActive: false })

    expect(markup).not.toContain('data-browser-pane-id="browser-a"')
    expect(markup).toContain('data-browser-pane-id="browser-b"')
    expect(markup).toContain('data-browser-pane-active="false"')
  })

  it('keeps a mobile-controlled hidden browser pane mounted', () => {
    mocks.mobileDrivenPageIds.add('page-b')

    const markup = renderOverlay({ isWorktreeActive: false })

    expect(markup).not.toContain('data-browser-pane-id="browser-a"')
    expect(markup).toContain('data-browser-pane-id="browser-b"')
    expect(markup).toContain('data-browser-pane-active="false"')
  })

  it('keeps a remotely viewed hidden browser pane mounted', () => {
    mocks.remotelyViewedPageIds.add('page-b')

    const markup = renderOverlay({ isWorktreeActive: false })

    expect(markup).not.toContain('data-browser-pane-id="browser-a"')
    expect(markup).toContain('data-browser-pane-id="browser-b"')
    expect(markup).toContain('data-browser-pane-active="false"')
  })

  // Why the style and not just mountedness: paintability drives the slot's `display`, and
  // display:none is the exact park that stops Chromium producing frames. A mounted pane inside a
  // display:none slot still goes dark, so mount assertions alone cannot see this regression.
  it('paints the slot of a remotely viewed inactive browser pane', () => {
    expect(slotDisplay('browser-b')).toBe('none')

    cleanup()
    mocks.remotelyViewedPageIds.add('page-b')

    expect(slotDisplay('browser-b')).toBe('flex')
  })

  // Why DOM order and not just presence: the host-row pane carries no guest and paints over
  // whichever webview the group was showing. Both siblings are absolutely positioned onto the same
  // anchor, so the only thing putting it on top is being last — a reorder is invisible to every
  // other assertion here and would bury it under a guest.
  it('renders the client-hosted host-row pane after every browser slot', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [HOST_ROW] })
    selectClientHostedBrowserRow({
      worktreeId: 'wt-1',
      browserPageId: HOST_ROW.browserPageId,
      groupId: 'group-1',
      groupActiveTabIdAtSelection: 'tab-a'
    })

    const view = render(<BrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive />)

    const ordered = [
      ...view.container.querySelectorAll(
        '[data-browser-overlay-tab-id],[data-client-hosted-browser-host-row-pane]'
      )
    ].map(
      (node) =>
        node.getAttribute('data-browser-overlay-tab-id') ??
        `host-row:${node.getAttribute('data-client-hosted-browser-host-row-pane')}`
    )
    expect(ordered).toEqual(['browser-a', 'browser-b', 'host-row:page-hosted'])
  })
})

function renderOverlay({ isWorktreeActive }: { isWorktreeActive: boolean }): string {
  return renderToStaticMarkup(
    <BrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive={isWorktreeActive} />
  )
}

function slotDisplay(browserTabId: string): string {
  const view = render(<BrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive={true} />)
  const slot = view.container.querySelector<HTMLElement>(
    `[data-browser-overlay-tab-id="${browserTabId}"]`
  )
  if (!slot) {
    throw new Error(`no overlay slot rendered for ${browserTabId}`)
  }
  return slot.style.display
}

function createState(): MockAppState {
  const browserA = createBrowserTab('browser-a', ['page-a'])
  const browserB = createBrowserTab('browser-b', ['page-b'])
  const tabA = createUnifiedBrowserTab('tab-a', browserA.id, 0)
  const tabB = createUnifiedBrowserTab('tab-b', browserB.id, 1)

  return {
    browserTabsByWorktree: { 'wt-1': [browserA, browserB] },
    unifiedTabsByWorktree: { 'wt-1': [tabA, tabB] },
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: tabA.id,
          tabOrder: [tabA.id, tabB.id]
        }
      ]
    },
    // Default: the browser's own group holds focus, so active === focused.
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    focusGroup: mocks.focusGroup
  }
}

function createUnifiedBrowserTab(id: string, browserTabId: string, sortOrder: number): Tab {
  return {
    id,
    entityId: browserTabId,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'browser',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function createBrowserTab(id: string, pageIds: string[]): BrowserTabState {
  return {
    id,
    worktreeId: 'wt-1',
    label: id,
    sessionProfileId: null,
    activePageId: pageIds[0] ?? null,
    pageIds,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}
