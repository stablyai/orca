// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { buildBrowserPage } from '@/store/slices/browser-page-records'
import { BrowserNavigationControlRow } from './browser-navigation-control-row'
import { BrowserToolbarVisibilityMenuItem } from './browser-toolbar-visibility-menu-item'
import { useBrowserPageChromeFocus } from './use-browser-page-chrome-focus'
import { useElementGuestFocus } from './browser-page-guest-focus'

const page = buildBrowserPage(
  'workspace-1',
  'wt-1',
  'https://example.com',
  'Example',
  null,
  'page-1'
)
let frames: FrameRequestCallback[] = []
let focusFromGuest: ((target: { browserPageId: string }) => void) | undefined
function Pane(): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const guest = useRef<HTMLDivElement>(null)
  const guestFocus = useElementGuestFocus(guest)
  useBrowserPageChromeFocus({
    browserTabId: page.id,
    workspaceId: page.workspaceId,
    isActive: true,
    chromeShortcutScope: 'focused',
    addressBarInputRef: input,
    guestFocus
  })
  return (
    <div data-browser-overlay-tab-id={page.workspaceId}>
      <ContextMenu>
        <ContextMenuTrigger>Workspace browser tab</ContextMenuTrigger>
        <ContextMenuContent>
          <BrowserToolbarVisibilityMenuItem browserPageId={page.id} menuKind="context" />
        </ContextMenuContent>
      </ContextMenu>
      <BrowserNavigationControlRow
        browserPageId={page.id}
        controls={{
          canGoBack: true,
          canGoForward: false,
          goBack: vi.fn(),
          goForward: vi.fn(),
          reload: vi.fn(),
          navigate: vi.fn()
        }}
        addressSlot={<input aria-label="Address" ref={input} defaultValue={page.url} />}
      >
        <button>Browser tools</button>
      </BrowserNavigationControlRow>
      <div ref={guest} tabIndex={-1} data-testid="guest">
        Page content
      </div>
    </div>
  )
}
function flushFrames(): void {
  for (let i = 0; i < 8; i++) {
    const pending = frames
    frames = []
    pending.forEach((callback) => callback(0))
  }
}
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onFocusBrowserAddressBar: (cb: typeof focusFromGuest) => {
          focusFromGuest = cb
          return () => {}
        },
        onShowBrowserHistory: () => () => {}
      }
    }
  })
  useAppStore.setState({
    browserPagesByWorkspace: { [page.workspaceId]: [page] },
    pendingAddressBarFocusByPageId: {},
    pendingAddressBarFocusByTabId: {}
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('chromeless browser controls', () => {
  it('hides the whole toolbar and restores it from the still-accessible tab menu', async () => {
    render(<Pane />)
    fireEvent.contextMenu(screen.getByText('Workspace browser tab'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide Browser Toolbar' }))
    expect(screen.queryByLabelText('Address')).toBeNull()
    expect(screen.queryByLabelText('Back')).toBeNull()
    expect(screen.queryByText('Browser tools')).toBeNull()
    expect(screen.getByText('Page content')).toBeTruthy()
    fireEvent.contextMenu(screen.getByText('Workspace browser tab'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show Browser Toolbar' }))
    expect(screen.getByLabelText('Address')).toBeTruthy()
    expect(screen.getByLabelText('Back')).toBeTruthy()
  })

  it.each(['chrome', 'guest'])(
    'reveals and focuses a hidden address bar for a %s shortcut',
    (origin) => {
      useAppStore.getState().setBrowserPageChromeless(page.id, true)
      render(<Pane />)
      act(() => screen.getByTestId('guest').focus())
      act(() => {
        if (origin === 'guest') {
          focusFromGuest!({ browserPageId: page.id })
        } else {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'l',
              ctrlKey: getShortcutPlatform() !== 'darwin',
              metaKey: getShortcutPlatform() === 'darwin',
              bubbles: true,
              cancelable: true
            })
          )
        }
      })
      act(flushFrames)
      const address = screen.getByLabelText<HTMLInputElement>('Address')
      expect(document.activeElement).toBe(address)
      expect(address.selectionStart).toBe(0)
      expect(address.selectionEnd).toBe(page.url.length)
    }
  )
})
