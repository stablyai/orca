// @vitest-environment happy-dom
import { cleanup, render, renderHook } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBrowserPageKeyboardShortcuts } from '../../host-guest/input/use-browser-page-keyboard-shortcuts'
import { useMarkupKeyboardShortcuts } from '../drawing/useMarkupKeyboardShortcuts'
import { BrowserAnnotateToolPalette } from './BrowserAnnotateToolPalette'
import { setAnnotatePaletteRatio } from './annotate-palette-position-store'

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

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

/** Focus sits where it does in Draw: on a control in this page's palette. */
function focusInPalette(): HTMLButtonElement {
  const palette = document.createElement('div')
  palette.setAttribute('data-browser-annotate-page', PAGE_ID)
  const button = document.createElement('button')
  palette.append(button)
  document.body.append(palette)
  button.focus()
  return button
}

function press(target: HTMLElement, key: string, code = `Key${key.toUpperCase()}`): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
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
