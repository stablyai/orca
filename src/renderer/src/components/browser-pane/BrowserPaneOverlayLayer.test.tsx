import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTab as BrowserTabState, Tab, TabGroup } from '../../../../shared/types'

type MockAppState = {
  browserTabsByWorktree: Record<string, readonly BrowserTabState[]>
  unifiedTabsByWorktree: Record<string, readonly Tab[]>
  groupsByWorktree: Record<string, readonly TabGroup[]>
  focusGroup: (worktreeId: string, groupId: string) => void
}

const mocks = vi.hoisted(() => ({
  state: null as MockAppState | null,
  automationVisiblePageIds: new Set<string>(),
  mobileDrivenPageIds: new Set<string>(),
  focusGroup: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

vi.mock('./browser-automation-visibility', () => ({
  useBrowserAutomationVisibilityForAny: (pageIds: readonly string[]) =>
    pageIds.some((pageId) => mocks.automationVisiblePageIds.has(pageId))
}))

vi.mock('@/lib/pane-manager/browser-mobile-driver-state', () => ({
  useBrowserMobileDriverForAny: (pageIds: readonly string[]) =>
    pageIds.some((pageId) => mocks.mobileDrivenPageIds.has(pageId))
}))

vi.mock('./BrowserPane', () => ({
  default: ({ browserTab, isActive }: { browserTab: BrowserTabState; isActive: boolean }) => (
    <span
      data-browser-pane-id={browserTab.id}
      data-browser-pane-active={isActive ? 'true' : 'false'}
    />
  )
}))

import BrowserPaneOverlayLayer from './BrowserPaneOverlayLayer'

describe('BrowserPaneOverlayLayer', () => {
  beforeEach(() => {
    mocks.automationVisiblePageIds.clear()
    mocks.mobileDrivenPageIds.clear()
    mocks.focusGroup.mockClear()
    mocks.state = createState()
  })

  it('keeps inactive browser panes mounted for a visible worktree', () => {
    const markup = renderOverlay({ isWorktreeActive: true })

    expect(markup).toContain('data-browser-pane-id="browser-a"')
    expect(markup).toContain('data-browser-pane-active="true"')
    expect(markup).toContain('data-browser-pane-id="browser-b"')
    expect(markup).toContain('data-browser-pane-active="false"')
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
})

function renderOverlay({ isWorktreeActive }: { isWorktreeActive: boolean }): string {
  return renderToStaticMarkup(
    <BrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive={isWorktreeActive} />
  )
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
