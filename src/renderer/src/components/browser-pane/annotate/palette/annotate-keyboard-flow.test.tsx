// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserGrabShortcuts } from '../use-browser-grab-shortcuts'
import { useMarkupKeyboardShortcuts } from '../drawing/useMarkupKeyboardShortcuts'
import { useGrabMode } from '../grab/useGrabMode'
import { useBrowserPageGrabAnnotations } from '../grab/use-browser-page-grab-annotations'
import { useMarkupMode, type MarkupCaptureContext } from '../capture/useMarkupMode'
import { registerAnnotateKeyPage } from './annotate-esc-ownership'
import { useBrowserAnnotateToolSwitch } from './use-browser-annotate-tool-switch'
import { useAnnotateKeyPage } from './use-annotate-key-page'

vi.mock('@/store/index', () => ({
  useAppStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({
      keybindings: {},
      recordFeatureInteraction: () => {},
      addBrowserPageAnnotation: () => {}
    })
}))
vi.mock('../../host-guest/input/use-browser-page-webview-shortcuts', () => ({
  useBrowserPageWebviewShortcuts: () => {}
}))
// The page capture is the only stub on the Draw side.
vi.mock('../capture/markup-base-image', () => ({
  captureMarkupBaseImage: async () => ({
    dataUrl: 'data:image/png;base64,AA',
    width: 8,
    height: 8
  }),
  flattenCapturedPage: async (capture: unknown) => capture
}))
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'toast', { error: () => 'error', dismiss: () => {} })
}))

const CAPTURE: MarkupCaptureContext = {
  source: { kind: 'image', element: document.createElement('img') },
  cssWidth: 8,
  cssHeight: 8,
  outputScale: 1
}

// Lets a test hold the picker's teardown open, to look at the moment Draw is still waiting for it.
let holdTeardown = false
// Holds Draw's page capture, to look at the moment before its drawing (and the drawing's Esc owner) mounts.
let holdCapture = false
let releaseTeardown: (() => void) | null = null

beforeEach(() => {
  holdTeardown = false
  holdCapture = false
  releaseTeardown = null
  Object.defineProperty(Element.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        setGrabMode: ({ enabled }: { enabled: boolean }) =>
          !enabled && holdTeardown
            ? new Promise((resolve) => {
                releaseTeardown = () => resolve({ ok: true, clean: true })
              })
            : Promise.resolve({ ok: true, clean: true }),
        onGuestEscape: () => () => {},
        onGrabModeToggle: () => () => {},
        onGrabActionShortcut: () => () => {},
        cancelGrab: async () => true,
        captureSelectionScreenshot: async () => ({ ok: false }),
        extractHoverPayload: async () => ({ ok: false }),
        captureCleanPage: () =>
          holdCapture
            ? new Promise(() => {})
            : Promise.resolve({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 }),
        awaitGrabSelection: () => new Promise(() => {})
      },
      ui: { writeClipboardText: async () => {}, writeClipboardImage: async () => {} }
    }
  })
})

const leaves: (() => void)[] = []
afterEach(() => {
  for (const leave of leaves.splice(0)) {
    leave()
  }
  cleanup()
  document.body.innerHTML = ''
})

/** A page's surface (viewport) with its palette, registered the way the overlays register it. */
function pageSurface(pageId: string): HTMLButtonElement {
  const surface = document.createElement('div')
  surface.setAttribute('data-browser-annotate-surface', pageId)
  const palette = document.createElement('div')
  palette.setAttribute('data-browser-annotate-page', pageId)
  const button = document.createElement('button')
  palette.append(button)
  surface.append(palette)
  document.body.append(surface)
  leaves.push(registerAnnotateKeyPage(pageId, () => surface))
  return button
}

/** One browser page's real tools: picker, Draw controller, tool switch, page keys and Draw's Esc owner. */
function renderPage(pageId: string) {
  return renderHook(() => {
    const grab = useGrabMode(pageId)
    const markup = useMarkupMode({ getCaptureContext: () => CAPTURE, onDeliver: () => {} })
    const grabAnnotations = useBrowserPageGrabAnnotations({
      browserTabId: pageId,
      isActive: true,
      grab,
      containerRef: { current: null },
      guestSurfaceRef: { current: null },
      setBrowserOverlayViewport: () => {},
      browserAnnotationsLength: 0
    })
    const tools = useBrowserAnnotateToolSwitch({
      grab,
      grabIntent: grabAnnotations.grabIntent,
      startGrabIntent: grabAnnotations.startGrabIntent,
      cancelPendingBrowserCapture: grabAnnotations.cancelPendingBrowserCapture,
      markup,
      canPickElements: true,
      toolTargetId: pageId,
      documentKey: pageId
    })
    useBrowserGrabShortcuts({
      transport: grab.transport,
      browserTabId: pageId,
      workspaceId: 'workspace-1',
      chromeShortcutScope: 'inactive',
      markupIsActive: markup.isActive,
      startGrabIntent: tools.toggleTool,
      handleGrabActionShortcut: grabAnnotations.handleGrabActionShortcut,
      grabIsInteractive: grab.state !== 'idle' && grab.state !== 'error',
      palette: {
        isActive: true,
        active: tools.activeTool !== null,
        onToolKey: tools.selectToolByKey
      }
    })
    useMarkupKeyboardShortcuts({
      pendingText: null,
      setPendingText: () => {},
      undo: () => {},
      redo: () => {},
      // As in the app, the drawing (and its Esc) exists only once the page image has arrived.
      onCancel: markup.baseImage ? tools.exit : () => {},
      ownerPageId: pageId
    })
    return { grab, markup, grabAnnotations, tools }
  })
}

function press(target: EventTarget, key: string): void {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true })
    )
  })
}

async function enterDraw(page: ReturnType<typeof renderPage>): Promise<void> {
  act(() => page.result.current.tools.selectTool('draw'))
  await waitFor(() => expect(page.result.current.markup.state).toBe('drawing'))
}

describe('annotate keys on the real tools', () => {
  it('from Draw, A, G and D switch tools and C/S do nothing; Esc leaves the mode', async () => {
    const page = renderPage('page-1')
    const paletteButton = pageSurface('page-1')
    await enterDraw(page)

    press(paletteButton, 'c')
    press(paletteButton, 's')
    expect(page.result.current.tools.activeTool).toBe('draw')
    expect(page.result.current.grabAnnotations.grabToast).toBeNull()

    press(paletteButton, 'a')
    await waitFor(() => expect(page.result.current.tools.activeTool).toBe('annotate'))
    press(paletteButton, 'g')
    await waitFor(() => expect(page.result.current.tools.activeTool).toBe('copy'))
    press(paletteButton, 'd')
    await waitFor(() => expect(page.result.current.markup.state).toBe('drawing'))

    // A Draw stroke leaves focus on the body; Esc from there still reaches this page.
    press(document.body, 'Escape')
    expect(page.result.current.tools.activeTool).toBeNull()
  })

  it('while Draw waits for the picker to clear, G still switches (the wait is dropped)', async () => {
    const page = renderPage('page-1')
    const paletteButton = pageSurface('page-1')
    act(() => page.result.current.tools.selectTool('copy'))
    await waitFor(() => expect(page.result.current.grab.state).toBe('awaiting'))
    holdTeardown = true
    act(() => page.result.current.tools.selectTool('draw'))
    await waitFor(() => expect(releaseTeardown).not.toBeNull())
    expect(page.result.current.tools.activeTool).toBe('draw')
    holdTeardown = false

    press(paletteButton, 'g')
    await waitFor(() => expect(page.result.current.tools.activeTool).toBe('copy'))
    await act(async () => releaseTeardown?.())

    expect(page.result.current.markup.state).toBe('idle')
    expect(page.result.current.tools.activeTool).toBe('copy')
  })

  it('letters from an unrelated control or an open menu leave the tool as it is', async () => {
    const page = renderPage('page-1')
    pageSurface('page-1')
    act(() => page.result.current.tools.selectTool('annotate'))
    await waitFor(() => expect(page.result.current.grab.state).toBe('awaiting'))
    const sidebarButton = document.createElement('button')
    const menuItem = document.createElement('div')
    menuItem.setAttribute('role', 'menuitem')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.append(menuItem)
    document.body.append(sidebarButton, menu)

    for (const target of [sidebarButton, menuItem]) {
      for (const key of ['d', 'g', 'c', 's']) {
        press(target, key)
      }
    }

    expect(page.result.current.tools.activeTool).toBe('annotate')
    expect(page.result.current.markup.state).toBe('idle')
    expect(page.result.current.grabAnnotations.grabToast).toBeNull()
  })

  it('with two pages in the mode, a key from no element switches only the page used last', async () => {
    const first = renderPage('page-1')
    const second = renderPage('page-2')
    pageSurface('page-1')
    act(() => first.result.current.tools.selectTool('annotate'))
    act(() => second.result.current.tools.selectTool('annotate'))
    const secondSurface = pageSurface('page-2')
    await waitFor(() => expect(second.result.current.grab.state).toBe('awaiting'))
    // A press in page 2 (a stroke or a click) leaves focus on the body.
    act(() => {
      secondSurface.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })

    press(document.body, 'g')

    await waitFor(() => expect(second.result.current.tools.activeTool).toBe('copy'))
    expect(first.result.current.tools.activeTool).toBe('annotate')
  })

  it('chrome without the palette still owns Esc for its armed picker', async () => {
    const surface = document.createElement('div')
    document.body.append(surface)
    const page = renderHook(() => {
      const grab = useGrabMode('page-1')
      useAnnotateKeyPage({
        pageId: 'page-1',
        containerRef: { current: surface },
        paletteToolActive: false,
        grabActive: grab.state !== 'idle',
        markupActive: false
      })
      return grab
    })
    act(() => page.result.current.toggle())
    await waitFor(() => expect(page.result.current.state).toBe('awaiting'))

    press(document.body, 'Escape')

    expect(page.result.current.state).toBe('idle')
  })

  it('Esc while Draw captures the page leaves the mode, before the drawing mounts its own owner', async () => {
    holdCapture = true
    const page = renderPage('page-1')
    pageSurface('page-1')
    act(() => page.result.current.tools.selectTool('draw'))
    await waitFor(() => expect(page.result.current.markup.state).toBe('capturing'))

    press(document.body, 'Escape')

    await waitFor(() => expect(page.result.current.tools.activeTool).toBeNull())
  })
})
