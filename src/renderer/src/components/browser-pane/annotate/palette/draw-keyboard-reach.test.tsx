// @vitest-environment happy-dom
import { cleanup, render, renderHook } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBrowserPageKeyboardShortcuts } from '../../host-guest/input/use-browser-page-keyboard-shortcuts'
import { useMarkupKeyboardShortcuts } from '../drawing/useMarkupKeyboardShortcuts'
import { BrowserAnnotateToolPalette } from './BrowserAnnotateToolPalette'
import { setAnnotatePaletteRatio } from './annotate-palette-position-store'
import { registerAnnotateKeyPage } from './annotate-esc-ownership'

vi.mock('@/store/index', () => ({
  useAppStore: (select: (state: { keybindings: Record<string, never> }) => unknown) =>
    select({ keybindings: {} })
}))
vi.mock('../../host-guest/input/use-browser-page-webview-shortcuts', () => ({
  useBrowserPageWebviewShortcuts: () => {}
}))

const PAGE_ID = 'page-1'

beforeEach(() => {
  setAnnotatePaletteRatio(0.5)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onGrabModeToggle: () => () => {},
        onGrabActionShortcut: () => () => {}
      }
    }
  })
})

let leaveMode: (() => void) | null = null
afterEach(() => {
  leaveMode?.()
  leaveMode = null
  cleanup()
  document.body.innerHTML = ''
})

/** Focus sits where it does in Draw: on a control in this page's palette, with the page in annotate mode. */
function focusInPalette(): HTMLButtonElement {
  Object.defineProperty(Element.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
  const surface = document.createElement('div')
  surface.setAttribute('data-browser-annotate-surface', PAGE_ID)
  const palette = document.createElement('div')
  palette.setAttribute('data-browser-annotate-page', PAGE_ID)
  const button = document.createElement('button')
  palette.append(button)
  surface.append(palette)
  document.body.append(surface)
  leaveMode ??= registerAnnotateKeyPage(PAGE_ID, () => surface)
  button.focus()
  return button
}

function press(target: HTMLElement, key: string, code = `Key${key.toUpperCase()}`): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
}

function renderPageKeys(
  browserTabId: string,
  handlers: {
    handleAnnotateToolKey: (key: 'a' | 'g' | 'd') => void
    handleGrabActionShortcut: (key: 'c' | 's') => void
    picking?: boolean
  }
): void {
  renderHook(() =>
    useBrowserPageKeyboardShortcuts({
      browserTabId,
      workspaceId: 'workspace-1',
      isActive: true,
      chromeShortcutScope: 'inactive',
      isActiveRef: { current: true },
      markupIsActive: !handlers.picking,
      webviewRef: { current: null },
      showBrowserZoomFeedback: vi.fn(),
      reloadWebviewOrRecoverGuest: vi.fn(),
      startGrabIntent: vi.fn(),
      handleGrabActionShortcut: handlers.handleGrabActionShortcut,
      handleAnnotateToolKey: handlers.handleAnnotateToolKey,
      grabIsInteractive: Boolean(handlers.picking)
    })
  )
}

describe('keyboard reach while drawing', () => {
  it('A, G and D switch tools from Draw; C and S stay inert there', () => {
    const handleAnnotateToolKey = vi.fn()
    const handleGrabActionShortcut = vi.fn()
    renderHook(() =>
      useBrowserPageKeyboardShortcuts({
        browserTabId: PAGE_ID,
        workspaceId: 'workspace-1',
        isActive: true,
        chromeShortcutScope: 'inactive',
        isActiveRef: { current: true },
        markupIsActive: true,
        webviewRef: { current: null },
        showBrowserZoomFeedback: vi.fn(),
        reloadWebviewOrRecoverGuest: vi.fn(),
        startGrabIntent: vi.fn(),
        handleGrabActionShortcut,
        handleAnnotateToolKey,
        grabIsInteractive: false
      })
    )
    const target = focusInPalette()

    press(target, 'a')
    press(target, 'g')
    press(target, 'd')
    press(target, 'c')
    press(target, 's')

    expect(handleAnnotateToolKey.mock.calls).toEqual([['a'], ['g'], ['d']])
    expect(handleGrabActionShortcut).not.toHaveBeenCalled()
  })

  it('letters from an unrelated control or an open menu do nothing, so the clipboard and page stay as they were', () => {
    const handleAnnotateToolKey = vi.fn()
    const handleGrabActionShortcut = vi.fn()
    renderPageKeys(PAGE_ID, { handleAnnotateToolKey, handleGrabActionShortcut, picking: true })
    focusInPalette()
    const sidebarButton = document.createElement('button')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const menuItem = document.createElement('div')
    menuItem.setAttribute('role', 'menuitem')
    menuItem.tabIndex = -1
    menu.append(menuItem)
    document.body.append(sidebarButton, menu)

    for (const target of [sidebarButton, menuItem]) {
      for (const key of ['a', 'g', 'd', 'c', 's']) {
        press(target, key)
      }
    }

    expect(handleAnnotateToolKey).not.toHaveBeenCalled()
    expect(handleGrabActionShortcut).not.toHaveBeenCalled()
  })

  it('with two pages in the mode, a key from no element reaches only the page used last', () => {
    const first = { handleAnnotateToolKey: vi.fn(), handleGrabActionShortcut: vi.fn() }
    const second = { handleAnnotateToolKey: vi.fn(), handleGrabActionShortcut: vi.fn() }
    renderPageKeys(PAGE_ID, first)
    renderPageKeys('page-2', second)
    focusInPalette()
    const otherSurface = document.createElement('div')
    otherSurface.setAttribute('data-browser-annotate-surface', 'page-2')
    document.body.append(otherSurface)
    const leaveOther = registerAnnotateKeyPage('page-2', () => otherSurface)
    // A press on page 2 (a Draw stroke there) leaves focus on the body.
    otherSurface.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }

    press(document.body, 'g')

    expect(second.handleAnnotateToolKey.mock.calls).toEqual([['g']])
    expect(first.handleAnnotateToolKey).not.toHaveBeenCalled()
    leaveOther()
  })

  it('Esc from the palette leaves Draw', () => {
    const onCancel = vi.fn()
    renderHook(() =>
      useMarkupKeyboardShortcuts({
        pendingText: null,
        setPendingText: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        onCancel,
        ownerPageId: PAGE_ID
      })
    )

    press(focusInPalette(), 'Escape', 'Escape')

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('keeps the palette in the Tab order while drawing', () => {
    function Harness(): React.JSX.Element {
      const boundsRef = useRef<HTMLDivElement>(null)
      const [open, setOpen] = useState(false)
      useEffect(() => setOpen(true), [])
      return (
        <TooltipProvider>
          <div ref={boundsRef}>
            {open ? (
              <BrowserAnnotateToolPalette
                boundsRef={boundsRef}
                pageId={null}
                ownerPageId={PAGE_ID}
                activeTool="draw"
                onSelectTool={vi.fn()}
                onDone={vi.fn()}
                canPickElements
                showKeyHints
                hint=""
                hintIsError={false}
                annotateActions={null}
                grabCopyDone={false}
                grabPicked={false}
                grabCanScreenshot={false}
                onGrabCopy={vi.fn()}
                onGrabScreenshot={vi.fn()}
                onDrawSlotChange={vi.fn()}
                onDrawDensityChange={vi.fn()}
              />
            ) : null}
          </div>
        </TooltipProvider>
      )
    }
    const view = render(<Harness />)

    // The selected tool is the group's one Tab stop (arrows move within it), and Done follows it.
    const draw = view.getByRole('button', { name: 'Draw' })
    expect(draw.tabIndex).toBe(0)
    expect(draw.closest('[inert]')).toBeNull()
    const done = view.getByRole('button', { name: /Done/ })
    expect(done.tabIndex).toBe(0)
    expect(draw.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
