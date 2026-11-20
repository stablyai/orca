// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGrabMode } from '../grab/useGrabMode'
import { useBrowserPageGrabAnnotations } from '../grab/use-browser-page-grab-annotations'
import { useMarkupMode, type MarkupCaptureContext } from '../capture/useMarkupMode'
import type { MarkupShape } from '../drawing/markup-drawing-model'
import { useBrowserAnnotateToolSwitch } from './use-browser-annotate-tool-switch'
import { browserPageDocumentIdentity } from './browser-page-document-identity'

// The page capture is the only stub: each capture is a new, numbered frozen page.
const capture = vi.hoisted(() => ({ count: 0 }))
vi.mock('../capture/markup-base-image', () => ({
  captureMarkupBaseImage: async () => ({
    dataUrl: `data:image/png;base64,capture-${++capture.count}`,
    width: 800,
    height: 600
  })
}))

// The toast is UI the user clicks; keep its options so the test can press Undo or let it time out.
type ToastOptions = { action?: { onClick: () => void }; onAutoClose?: () => void }
const toasts = vi.hoisted((): { last: ToastOptions | null } => ({ last: null }))
vi.mock('sonner', () => ({
  toast: Object.assign(
    (_message: string, options?: ToastOptions) => {
      toasts.last = options ?? null
      return 'toast'
    },
    { error: () => 'error', dismiss: () => {} }
  )
}))

const PAGE_ID = 'page-1'
const CAPTURE_CONTEXT: MarkupCaptureContext = {
  source: { kind: 'image', element: document.createElement('img') },
  cssWidth: 800,
  cssHeight: 600,
  outputScale: 1
}
const strokeA: MarkupShape = {
  id: 'a',
  color: '#ef4444',
  kind: 'rect',
  from: { x: 1, y: 1 },
  to: { x: 9, y: 9 },
  width: 4
}
const strokeB: MarkupShape = { ...strokeA, id: 'b', from: { x: 20, y: 20 }, to: { x: 40, y: 40 } }

beforeEach(() => {
  capture.count = 0
  toasts.last = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        setGrabMode: async () => ({ ok: true }),
        onGuestEscape: () => () => {},
        cancelGrab: async () => true,
        captureSelectionScreenshot: async () => ({ ok: false }),
        awaitGrabSelection: () => new Promise(() => {})
      },
      ui: { writeClipboardText: async () => {} }
    }
  })
})

// The browser tab as the pane sees it; the tools get its document identity the way the pane passes it.
type Tab = { url: string; loading: boolean }
const LOADED: Tab = { url: 'http://acme.test/', loading: false }

function renderTools() {
  return renderHook(
    (tab: Tab) => {
      const grab = useGrabMode(PAGE_ID)
      const markup = useMarkupMode({
        getCaptureContext: () => CAPTURE_CONTEXT,
        onDeliver: () => {}
      })
      const grabAnnotations = useBrowserPageGrabAnnotations({
        browserTabId: PAGE_ID,
        isActive: true,
        grab,
        containerRef: { current: null },
        webviewRef: { current: null },
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
        toolTargetId: PAGE_ID,
        ...browserPageDocumentIdentity({ id: PAGE_ID, loading: tab.loading })
      })
      return { markup, tools }
    },
    { initialProps: LOADED }
  )
}

type Rendered = ReturnType<typeof renderTools>

async function enterDraw({ result }: Rendered): Promise<void> {
  act(() => result.current.tools.selectTool('draw'))
  await waitFor(() => expect(result.current.markup.state).toBe('drawing'))
}

function shownPage({ result }: Rendered): string | undefined {
  return result.current.markup.baseImage?.dataUrl
}

function drawAndLeave(rendered: Rendered, shapes: MarkupShape[]): void {
  act(() => rendered.result.current.tools.reportShapes(shapes))
  act(() => rendered.result.current.tools.exit())
  rendered.rerender(LOADED)
}

describe('getting a discarded drawing back', () => {
  it('Draw again while Undo is on offer brings back the same page and strokes, without a new capture', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    expect(shownPage(rendered)).toContain('capture-1')
    drawAndLeave(rendered, [strokeA])
    expect(rendered.result.current.tools.activeTool).toBeNull()

    await enterDraw(rendered)

    expect(shownPage(rendered)).toContain('capture-1')
    expect(capture.count).toBe(1)
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeA])
  })

  it('the Undo button brings it back too', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeA])

    act(() => toasts.last?.action?.onClick())

    expect(rendered.result.current.tools.activeTool).toBe('draw')
    expect(shownPage(rendered)).toContain('capture-1')
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeA])
  })

  it.each(['Draw again', 'the Undo button'] as const)(
    'brings it back once only (restored by %s): cleared and left, a later Draw captures afresh',
    async (entry) => {
      const rendered = renderTools()
      await enterDraw(rendered)
      drawAndLeave(rendered, [strokeA])
      const undo = toasts.last?.action
      if (entry === 'Draw again') {
        await enterDraw(rendered)
      } else {
        act(() => undo?.onClick())
        await waitFor(() => expect(rendered.result.current.markup.state).toBe('drawing'))
      }
      expect(shownPage(rendered)).toContain('capture-1')
      // Cleared, then left: nothing to offer back.
      drawAndLeave(rendered, [])
      // The earlier toast's Undo, still fading out, can't revive the consumed drawing either.
      act(() => undo?.onClick())
      expect(rendered.result.current.tools.activeTool).toBeNull()

      await enterDraw(rendered)

      expect(shownPage(rendered)).toContain('capture-2')
      expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
    }
  )

  it('never replaces a drawing that is open now when an old Undo is pressed', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeA])
    const staleUndo = toasts.last?.action
    // The offer runs out, and a new drawing is started.
    act(() => toasts.last?.onAutoClose?.())
    await enterDraw(rendered)
    expect(shownPage(rendered)).toContain('capture-2')

    act(() => staleUndo?.onClick())

    expect(shownPage(rendered)).toContain('capture-2')
    expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
  })

  it('once the offer runs out, Draw captures afresh', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeA])

    act(() => toasts.last?.onAutoClose?.())
    await enterDraw(rendered)

    expect(shownPage(rendered)).toContain('capture-2')
    expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
  })

  it('a newer discard replaces the older one', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeA])
    act(() => toasts.last?.onAutoClose?.())
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeB])

    await enterDraw(rendered)

    expect(shownPage(rendered)).toContain('capture-2')
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeB])
  })

  it('a reload of the page withdraws the offer: Draw captures the new document', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeA])

    rendered.rerender({ ...LOADED, loading: true })
    rendered.rerender(LOADED)
    await enterDraw(rendered)

    expect(shownPage(rendered)).toContain('capture-2')
    expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
  })

  it('a same-document URL change (pushState, hash) keeps the offer: Draw still restores', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeA])

    rendered.rerender({ url: 'http://acme.test/#pricing', loading: false })
    rendered.rerender({ url: 'http://acme.test/plans', loading: false })
    await enterDraw(rendered)

    expect(shownPage(rendered)).toContain('capture-1')
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeA])
  })

  it('leaving Draw with nothing drawn offers nothing back', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [])
    expect(toasts.last).toBeNull()

    await enterDraw(rendered)

    expect(shownPage(rendered)).toContain('capture-2')
  })
})
