// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import type * as BrowserViewportPresetActions from './browser-viewport-preset-actions'
import { useBrowserPageViewportShortcut } from './use-browser-page-viewport-shortcut'

const applyPreset = vi.hoisted(() => vi.fn())
vi.mock('./browser-viewport-preset-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserViewportPresetActions>()),
  applyBrowserPageViewportPreset: applyPreset
}))

const page: BrowserPage = {
  id: 'page-1',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
  url: 'https://example.com',
  title: 'Example',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 1,
  viewportPresetId: 'desktop',
  lastMobileViewportPresetId: 'mobile-l',
  lastDesktopViewportPresetId: 'desktop'
}

let guestToggle: ((browserPageId: string) => void) | null = null

function Harness({ scope = 'focused' }: { scope?: BrowserChromeShortcutScope }): React.JSX.Element {
  useBrowserPageViewportShortcut({
    browserPage: page,
    workspaceId: page.workspaceId,
    chromeShortcutScope: scope
  })
  return <input data-browser-overlay-tab-id={page.workspaceId} data-testid="browser-input" />
}

function pressViewportChord(target: HTMLElement = window.document.body): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'v',
        code: 'KeyV',
        metaKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  })
}

describe('useBrowserPageViewportShortcut', () => {
  beforeEach(() => {
    applyPreset.mockReset()
    guestToggle = null
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onToggleBrowserViewport: (callback: (browserPageId: string) => void) => {
            guestToggle = callback
            return () => {
              guestToggle = null
            }
          }
        }
      }
    })
    useAppStore.setState({
      keybindings: { 'browser.toggleMobileDesktopViewport': ['Mod+Alt+V'] }
    })
  })

  afterEach(() => cleanup())

  it('applies the remembered mobile preset from browser chrome', () => {
    render(<Harness />)

    pressViewportChord()

    expect(applyPreset).toHaveBeenCalledWith('page-1', 'mobile-l')
  })

  it('does not claim the chord from a terminal or editor target in another split', () => {
    render(<Harness scope="owned-target" />)
    const terminalInput = document.createElement('textarea')
    document.body.append(terminalInput)

    pressViewportChord(terminalInput)
    expect(applyPreset).not.toHaveBeenCalled()

    pressViewportChord(document.querySelector('[data-testid="browser-input"]')!)
    expect(applyPreset).toHaveBeenCalledWith('page-1', 'mobile-l')
  })

  it('handles a focused guest event only for its own browser page', () => {
    render(<Harness />)

    act(() => guestToggle?.('other-page'))
    expect(applyPreset).not.toHaveBeenCalled()

    act(() => guestToggle?.('page-1'))
    expect(applyPreset).toHaveBeenCalledWith('page-1', 'mobile-l')
  })
})
