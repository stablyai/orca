// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'

type MockState = {
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  remoteBrowserPageHandlesByPageId: Record<string, never>
  focusGroup: () => void
  updateBrowserPageState: () => void
  setBrowserPageUrl: () => void
  settings: { browserSshWorkspaceRoutingEnabled: boolean }
}

const mocks = vi.hoisted(() => ({
  state: null as MockState | null,
  store: null as StoreApi<MockState> | null,
  executionHostId: 'local',
  prepare: vi.fn(),
  destroy: vi.fn()
}))

vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: (selector: (state: MockState) => unknown) => useStore(mocks.store!, selector)
  }
})
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null,
  getExecutionHostIdForWorktree: () => mocks.executionHostId
}))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('../host-guest/webview-registry', () => ({ destroyPersistentWebview: mocks.destroy }))
vi.mock('./BrowserMobileDriverOverlay', () => ({ BrowserMobileDriverOverlay: () => null }))
vi.mock('./browser-page-pane', () => ({
  BrowserPagePane: ({ browserTab, isActive }: { browserTab: BrowserPage; isActive: boolean }) => (
    <input data-page-id={browserTab.id} data-active={isActive} />
  )
}))
vi.mock('../workspace-doc/workspace-doc-page-pane', () => ({
  WorkspaceDocPagePane: ({ page, isActive }: { page: BrowserPage; isActive: boolean }) => (
    <input data-page-id={page.id} data-active={isActive} />
  )
}))

import BrowserPaneOverlayLayer from './BrowserPaneOverlayLayer'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '../host-guest/browser-automation-visibility'
import { hydrateBrowserDrivers } from '@/lib/pane-manager/browser-mobile-driver-state'
import { hydrateBrowserRemoteViewerPages } from '@/lib/pane-manager/browser-remote-viewer-state'

function createState(): MockState {
  const browsers: BrowserWorkspace[] = ['a', 'b'].map((id) => ({
    id,
    worktreeId: 'wt-1',
    label: id,
    sessionProfileId: null,
    activePageId: `${id}-1`,
    pageIds: [`${id}-1`, `${id}-2`],
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }))
  return {
    browserTabsByWorktree: { 'wt-1': browsers },
    browserPagesByWorkspace: Object.fromEntries(
      browsers.map((browser) => [
        browser.id,
        (browser.pageIds ?? []).map((id) => ({ ...browser, id, workspaceId: browser.id }))
      ])
    ),
    unifiedTabsByWorktree: {
      'wt-1': browsers.map((browser, index) => ({
        id: browser.id,
        entityId: browser.id,
        groupId: 'group-1',
        worktreeId: 'wt-1',
        contentType: 'browser',
        label: browser.id,
        customLabel: null,
        color: null,
        sortOrder: index,
        createdAt: 1
      }))
    },
    groupsByWorktree: {
      'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: 'a', tabOrder: ['a', 'b'] }]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    remoteBrowserPageHandlesByPageId: {},
    focusGroup: () => {},
    updateBrowserPageState: () => {},
    setBrowserPageUrl: () => {},
    settings: { browserSshWorkspaceRoutingEnabled: true }
  }
}

function selectTab(id: string): void {
  mocks.state!.groupsByWorktree['wt-1'] = [
    { ...mocks.state!.groupsByWorktree['wt-1'][0], activeTabId: id }
  ]
}

function selectPage(id: string): void {
  mocks.state!.browserTabsByWorktree['wt-1'] = mocks.state!.browserTabsByWorktree['wt-1'].map(
    (browser) => (browser.id === 'a' ? { ...browser, activePageId: id } : browser)
  )
}

const surface = (active = true) => (
  <BrowserPaneOverlayLayer worktreeId="wt-1" isWorktreeActive={active} />
)
function redraw(view: ReturnType<typeof render>, active = true): void {
  act(() => mocks.store!.setState({ ...mocks.state! }))
  view.rerender(surface(active))
}
const settle = () => act(async () => {})

describe('deferred browser lifecycle through the overlay and SSH gate', () => {
  beforeEach(() => {
    mocks.state = createState()
    mocks.store = createStore(() => mocks.state!)
    mocks.executionHostId = 'local'
    mocks.destroy.mockReset()
    mocks.prepare.mockReset().mockResolvedValue({ partition: 'persist:orca-browser-v1-routed' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { prepareSshWorkspacePartition: mocks.prepare } }
    })
  })
  afterEach(() => {
    cleanup()
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  it.each(['automation', 'mobile', 'viewer'])(
    'releases hidden sibling chrome without remounting the %s-claimed page',
    (consumer) => {
      const view = render(surface())
      selectPage('a-2')
      redraw(view)
      const claimed = view.container.querySelector('[data-page-id="a-2"]')
      selectTab('b')
      redraw(view)
      let token: string | null = null
      act(() => {
        if (consumer === 'automation') {
          token = acquireBrowserAutomationVisibility('a-2')
        }
        if (consumer === 'mobile') {
          hydrateBrowserDrivers([
            { browserPageId: 'a-2', driver: { kind: 'mobile', clientId: 'phone-1' } }
          ])
        }
        if (consumer === 'viewer') {
          hydrateBrowserRemoteViewerPages(['a-2'])
        }
      })
      try {
        redraw(view, false)
        expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(1)
        expect(view.container.querySelector('[data-page-id="a-2"]')).toBe(claimed)
        redraw(view)
        expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(2)
        expect(view.container.querySelector('[data-page-id="a-1"]')).toBeNull()
        expect(view.container.querySelector('[data-page-id="a-2"]')).toBe(claimed)
        redraw(view, false)
        act(() => {
          if (token) {
            releaseBrowserAutomationVisibility(token)
          }
          hydrateBrowserDrivers([])
          hydrateBrowserRemoteViewerPages([])
        })
        expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(0)
        redraw(view)
        expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(1)
        expect(view.container.querySelector('[data-page-id="b-1"]')).not.toBeNull()
      } finally {
        if (token) {
          releaseBrowserAutomationVisibility(token)
        }
      }
    }
  )

  it.each(['url', 'document'])(
    'retains %s content across page and tab switches within a visible worktree',
    (kind) => {
      if (kind === 'document') {
        mocks.state!.browserPagesByWorkspace.a[0].docLocation = {
          kind: 'workspace-doc',
          worktreeId: 'wt-1',
          filePath: '/workspace/report.html'
        }
      }
      const view = render(surface())
      const page = view.container.querySelector<HTMLInputElement>('[data-page-id="a-1"]')!
      page.value = 'unsaved state'
      page.scrollTop = 80
      expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(1)
      selectPage('a-2')
      redraw(view)
      expect(page.isConnected).toBe(true)
      expect(page.dataset.active).toBe('false')
      selectTab('b')
      redraw(view)
      expect(page.isConnected).toBe(true)
      selectPage('a-1')
      selectTab('a')
      redraw(view)
      expect(view.container.querySelector('[data-page-id="a-1"]')).toBe(page)
      expect(page.value).toBe('unsaved state')
      expect(page.scrollTop).toBe(80)
      expect(page.dataset.active).toBe('true')
      expect(view.container.querySelector('[data-page-id="b-2"]')).toBeNull()

      redraw(view, false)
      expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(0)
      redraw(view)
      const restored = view.container.querySelector('[data-page-id="a-1"]')!
      expect(restored).not.toBe(page)
      expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(1)

      mocks.state!.browserPagesByWorkspace.a = mocks.state!.browserPagesByWorkspace.a.slice(1)
      mocks.state!.browserTabsByWorktree['wt-1'] = [...mocks.state!.browserTabsByWorktree['wt-1']]
      redraw(view)
      expect(page.isConnected).toBe(false)
      expect(restored.isConnected).toBe(false)
    }
  )

  it('keeps a prepared SSH gate and its opened pages alive when switching tabs', async () => {
    mocks.executionHostId = 'ssh:target-a'
    const view = render(surface())
    await settle()
    const page = view.container.querySelector('[data-page-id="a-1"]')
    expect(page).not.toBeNull()
    mocks.destroy.mockClear()
    selectTab('b')
    redraw(view)
    await settle()
    expect(mocks.destroy.mock.calls.flat()).not.toContain('a-1')
    mocks.destroy.mockClear()
    mocks.prepare.mockClear()
    selectTab('a')
    redraw(view)
    await settle()
    expect(mocks.destroy).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-page-id="a-1"]')).toBe(page)
    redraw(view, false)
    expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(0)
    expect(mocks.destroy).not.toHaveBeenCalled()
    redraw(view)
    await settle()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-page-id="a-1"]')).not.toBe(page)
    expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(1)
  })

  it('guards all pages, including inactive tabs, when SSH routing is enabled', async () => {
    mocks.executionHostId = 'ssh:target-a'
    mocks.state!.settings.browserSshWorkspaceRoutingEnabled = false
    const view = render(surface())
    selectPage('a-2')
    redraw(view)
    selectTab('b')
    redraw(view)
    selectTab('a')
    redraw(view)
    mocks.destroy.mockClear()
    mocks.prepare.mockImplementation(() => new Promise(() => {}))
    mocks.state!.settings = { browserSshWorkspaceRoutingEnabled: true }
    mocks.state!.browserTabsByWorktree['wt-1'] = mocks.state!.browserTabsByWorktree['wt-1'].map(
      (browser) => ({ ...browser })
    )
    redraw(view)
    expect(view.container.querySelectorAll('[data-page-id]')).toHaveLength(0)
    expect(new Set(mocks.destroy.mock.calls.flat())).toEqual(new Set(['a-1', 'a-2', 'b-1', 'b-2']))
  })
})
