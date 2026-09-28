// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'

// Every per-page retention term reaches the guest as a prop on BrowserPagePane, where a wrong value
// parks the webview display:none. The threading itself had no coverage: a mutant hardcoding any of
// the three to false left the whole suite green.
type MockAppState = {
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  remoteBrowserPageHandlesByPageId: Record<string, never>
  updateBrowserPageState: () => void
  setBrowserPageUrl: () => void
}

const mocks = vi.hoisted(() => ({
  state: null as MockAppState | null,
  pageProps: [] as {
    id: string
    isAutomationVisible: boolean
    isMobileDriven: boolean
    isRemotelyViewed: boolean
  }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))

vi.mock('../host-guest/webview-registry', () => ({
  destroyPersistentWebview: () => {}
}))

vi.mock('./ssh-routed-browser-page-gate', () => ({
  SshRoutedBrowserPageGate: ({
    children
  }: {
    children: (routedPartition: string | null) => React.ReactNode
  }) => <>{children(null)}</>
}))

vi.mock('./BrowserMobileDriverOverlay', () => ({
  BrowserMobileDriverOverlay: () => null
}))

vi.mock('./browser-page-pane', () => ({
  BrowserPagePane: (props: {
    browserTab: BrowserPage
    isAutomationVisible: boolean
    isMobileDriven: boolean
    isRemotelyViewed: boolean
  }) => {
    mocks.pageProps.push({
      id: props.browserTab.id,
      isAutomationVisible: props.isAutomationVisible,
      isMobileDriven: props.isMobileDriven,
      isRemotelyViewed: props.isRemotelyViewed
    })
    return <span data-browser-page-id={props.browserTab.id} />
  }
}))

import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '../host-guest/browser-automation-visibility'
import { hydrateBrowserDrivers } from '@/lib/pane-manager/browser-mobile-driver-state'
import { hydrateBrowserRemoteViewerPages } from '@/lib/pane-manager/browser-remote-viewer-state'
import BrowserPane from './browser-workspace-pane'

const WORKSPACE_ID = 'ws-1'

function createPage(id: string): BrowserPage {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'wt-1',
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as unknown as BrowserPage
}

function createWorkspace(): BrowserWorkspace {
  return {
    id: WORKSPACE_ID,
    worktreeId: 'wt-1',
    label: 'browser',
    sessionProfileId: null,
    activePageId: 'page-a',
    pageIds: ['page-a', 'page-b'],
    url: 'about:blank',
    title: 'browser',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as unknown as BrowserWorkspace
}

function propsFor(pageId: string): (typeof mocks.pageProps)[number] {
  const props = mocks.pageProps.findLast((entry) => entry.id === pageId)
  if (!props) {
    throw new Error(`BrowserPagePane never rendered for ${pageId}`)
  }
  return props
}

function renderWorkspacePane(): void {
  mocks.pageProps = []
  render(<BrowserPane browserTab={createWorkspace()} isActive={true} />)
}

describe('browser workspace pane retention props', () => {
  beforeEach(() => {
    mocks.state = {
      browserPagesByWorkspace: { [WORKSPACE_ID]: [createPage('page-a'), createPage('page-b')] },
      remoteBrowserPageHandlesByPageId: {},
      updateBrowserPageState: () => {},
      setBrowserPageUrl: () => {}
    }
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  afterEach(() => {
    cleanup()
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  it('defers unopened pages out of 200 and retains opened pages until unmount', () => {
    const pages = Array.from({ length: 200 }, (_, index) => createPage(`page-${index}`))
    mocks.state!.browserPagesByWorkspace[WORKSPACE_ID] = pages
    const workspace = { ...createWorkspace(), activePageId: pages[0].id }
    const view = render(<BrowserPane browserTab={workspace} isActive />)
    const renderedIds = (): (string | null)[] =>
      [...view.container.querySelectorAll('[data-browser-page-id]')].map((node) =>
        node.getAttribute('data-browser-page-id')
      )
    expect(renderedIds()).toEqual(['page-0'])

    view.rerender(<BrowserPane browserTab={{ ...workspace, activePageId: 'page-199' }} isActive />)
    expect(renderedIds()).toEqual(['page-0', 'page-199'])
    view.rerender(<BrowserPane browserTab={workspace} isActive={false} />)
    expect(renderedIds()).toEqual(['page-0', 'page-199'])
    view.rerender(<BrowserPane key="restored" browserTab={workspace} isActive />)
    expect(renderedIds()).toEqual(['page-0'])
  })

  it.each(['automation', 'mobile', 'viewer'])('loads an inactive page for %s only', (consumer) => {
    const token = consumer === 'automation' ? acquireBrowserAutomationVisibility('page-b') : null
    if (consumer === 'mobile') {
      hydrateBrowserDrivers([
        { browserPageId: 'page-b', driver: { kind: 'mobile', clientId: 'phone-1' } }
      ])
    }
    if (consumer === 'viewer') {
      hydrateBrowserRemoteViewerPages(['page-b'])
    }
    try {
      const view = render(<BrowserPane browserTab={createWorkspace()} isActive={false} />)
      expect(view.container.querySelector('[data-browser-page-id="page-a"]')).toBeNull()
      expect(view.container.querySelector('[data-browser-page-id="page-b"]')).not.toBeNull()
    } finally {
      if (token) {
        releaseBrowserAutomationVisibility(token)
      }
    }
  })

  it('threads all three retention terms to the page that owns them', () => {
    renderWorkspacePane()
    expect(mocks.pageProps.some((props) => props.id === 'page-b')).toBe(false)

    cleanup()
    const token = acquireBrowserAutomationVisibility('page-b')
    hydrateBrowserDrivers([
      { browserPageId: 'page-b', driver: { kind: 'mobile', clientId: 'phone-1' } }
    ])
    hydrateBrowserRemoteViewerPages(['page-b'])
    renderWorkspacePane()

    expect(propsFor('page-b')).toEqual({
      id: 'page-b',
      isAutomationVisible: true,
      isMobileDriven: true,
      isRemotelyViewed: true
    })
    // Why the sibling: each term must land on the page it belongs to, not on every page of the tab.
    expect(propsFor('page-a')).toEqual({
      id: 'page-a',
      isAutomationVisible: false,
      isMobileDriven: false,
      isRemotelyViewed: false
    })
    releaseBrowserAutomationVisibility(token)
  })
})
