// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store: Record<string, unknown> = {}
  return { store, openDevTools: vi.fn(), openUrl: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.store)
}))

vi.mock('../host-guest/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))

import { ClientHostedBrowserOverflowMenu } from './client-hosted-browser-overflow-menu'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'

beforeEach(() => {
  mocks.store = {
    browserSessionProfiles: [],
    detectedBrowsers: [],
    switchBrowserTabProfile: vi.fn(),
    createBrowserSessionProfile: vi.fn(),
    importCookiesFromBrowser: vi.fn(),
    importCookiesToProfile: vi.fn(),
    fetchDetectedBrowsers: vi.fn(),
    browserSessionImportState: {},
    activeContextualTourId: null,
    activeContextualTourStepIndex: 0,
    browserImportHintHidden: true,
    persistedUIReady: true
  }
  Object.assign(window, {
    api: {
      browser: {
        openDevTools: mocks.openDevTools,
        getPageSiteDisplay: vi.fn(() => Promise.resolve(null)),
        zoomPage: vi.fn(() => Promise.resolve(null)),
        setPageSiteColorScheme: vi.fn(() => Promise.resolve(null)),
        setViewportOverride: vi.fn(() => Promise.resolve())
      },
      shell: { openUrl: mocks.openUrl }
    }
  })
})

afterEach(cleanup)

const basePage = {
  id: 'page-1',
  workspaceId: 'ws-1',
  worktreeId: 'worktree-1',
  url: 'https://example.com/worktree',
  title: 'Example',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 0,
  viewportPresetId: null
}

function page(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return { ...basePage, ...overrides }
}

describe('ClientHostedBrowserOverflowMenu', () => {
  it('renders the ⋯ trigger for a client-hosted page', () => {
    render(
      <ClientHostedBrowserOverflowMenu
        browserTab={page()}
        sessionProfileId={null}
        workspaceId="ws-1"
        isActive={true}
        onOpenFind={vi.fn()}
        onHardReload={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /browser menu/i })).toBeTruthy()
  })

  it('opens devtools for the client-hosted page from the menu', async () => {
    const user = userEvent.setup()
    const onFind = vi.fn()
    const onHardReload = vi.fn()
    render(
      <ClientHostedBrowserOverflowMenu
        browserTab={page()}
        sessionProfileId={null}
        workspaceId="ws-1"
        isActive={true}
        onOpenFind={onFind}
        onHardReload={onHardReload}
      />
    )
    await user.click(screen.getByRole('button', { name: /browser menu/i }))
    const devtools = await screen.findByRole(
      'menuitem',
      { name: /devtools/i },
      { timeout: 3000 }
    )
    await user.click(devtools)
    expect(mocks.openDevTools).toHaveBeenCalledWith({ browserPageId: 'page-1' })
  })

  it('shows Profile and Extensions disabled with reasons, not as live switchers', async () => {
    const user = userEvent.setup()
    render(
      <ClientHostedBrowserOverflowMenu
        browserTab={page()}
        sessionProfileId={null}
        workspaceId="ws-1"
        isActive={true}
        onOpenFind={vi.fn()}
        onHardReload={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /browser menu/i }))
    const items = await screen.findAllByRole('menuitem', {}, { timeout: 3000 })
    const profile = items.find((item) => /^profile/i.test(item.textContent ?? ''))
    const extensions = items.find((item) => /^extensions/i.test(item.textContent ?? ''))
    expect(profile?.getAttribute('data-disabled')).not.toBeNull()
    expect(profile?.textContent).toMatch(/not wired yet/i)
    expect(extensions?.getAttribute('data-disabled')).not.toBeNull()
    expect(extensions?.textContent).toMatch(/not available on pages hosted by this desktop yet/i)
  })

  it('disables open-external on a blank new tab page', async () => {
    const user = userEvent.setup()
    render(
      <ClientHostedBrowserOverflowMenu
        browserTab={page({ url: 'about:blank' })}
        sessionProfileId={null}
        workspaceId="ws-1"
        isActive={true}
        onOpenFind={vi.fn()}
        onHardReload={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /browser menu/i }))
    const items = await screen.findAllByRole('menuitem', {}, { timeout: 3000 })
    const external = items.find((item) =>
      /open in default browser/i.test(item.textContent ?? '')
    )
    expect(external).toBeTruthy()
    expect(external?.getAttribute('data-disabled')).not.toBeNull()
    expect(mocks.openUrl).not.toHaveBeenCalled()
  })
})
