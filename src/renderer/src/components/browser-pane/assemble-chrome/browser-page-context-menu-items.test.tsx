// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowser } from '../../../../../shared/external-browser-types'

type StoreState = {
  settings: { externalBrowserId?: string | null } | null
  installedBrowsers: InstalledBrowser[] | null
  browserDefaultSearchEngine: null
}
const storeState = vi.hoisted((): StoreState => ({
  settings: null,
  installedBrowsers: null,
  browserDefaultSearchEngine: null
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))
vi.mock('@/lib/browser-page-tab-opening', () => ({ openUrlInTabBesideBrowserPage: vi.fn() }))

import { BrowserPageContextMenuItems } from './browser-page-context-menu-items'

const LINK_URL = 'https://github.com/stablyai/orca/pull/1'
const BROWSERS: InstalledBrowser[] = [
  { id: 'chrome', name: 'Google Chrome' },
  { id: 'edge', name: 'Microsoft Edge' }
]
const openUrl = vi.fn()

function LinkMenu(): React.JSX.Element {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  return (
    <BrowserPageContextMenuItems
      menu={{
        x: 0,
        y: 0,
        pagePoint: { x: 0, y: 0 },
        linkUrl: LINK_URL,
        pageUrl: 'https://github.com/stablyai/orca',
        selectionText: '',
        editable: null,
        image: null
      }}
      browserPageId="page-1"
      worktreeId="wt-1"
      canGoBack={false}
      canGoForward={false}
      webviewRef={webviewRef}
      onReload={vi.fn()}
      onClose={vi.fn()}
    />
  )
}

function menuItemNames(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

beforeEach(() => {
  storeState.settings = null
  storeState.installedBrowsers = BROWSERS
  vi.stubGlobal('api', { shell: { openUrl }, ui: { writeClipboardText: vi.fn() } })
  openUrl.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('BrowserPageContextMenuItems link section', () => {
  it('lists Orca, the external default, each installed browser, then Copy Link Address', () => {
    render(<LinkMenu />)

    expect(menuItemNames()).toEqual([
      'Open Link In Orca Browser',
      'Open Link In System Browser',
      'Open Link In Google Chrome',
      'Open Link In Microsoft Edge',
      'Copy Link Address',
      'Inspect'
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Link In Google Chrome' }))
    expect(openUrl).toHaveBeenCalledWith(LINK_URL, 'chrome')
  })

  it('names the configured external browser and opens it without a browser id', () => {
    storeState.settings = { externalBrowserId: 'edge' }
    render(<LinkMenu />)

    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Open Link In Microsoft Edge' })[0])
    expect(openUrl).toHaveBeenCalledWith(LINK_URL)
  })

  it('offers only the external default when no browser can be chosen', () => {
    storeState.installedBrowsers = []
    render(<LinkMenu />)

    expect(menuItemNames()).toEqual([
      'Open Link In Orca Browser',
      'Open Link In System Browser',
      'Copy Link Address',
      'Inspect'
    ])
  })
})
