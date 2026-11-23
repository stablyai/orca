// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGrabMode } from '../grab/useGrabMode'
import { useBrowserPageGrabAnnotations } from '../grab/use-browser-page-grab-annotations'
import { useMarkupMode, type MarkupCaptureContext } from '../capture/useMarkupMode'
import type { MarkupShape } from '../drawing/markup-drawing-model'
import { useBrowserAnnotateToolSwitch } from './use-browser-annotate-tool-switch'
import { browserPageDocumentIdentity } from './browser-page-document-identity'

// Only the capture boundary is stubbed; restoration must retain its original snapshot object.
vi.mock('../capture/markup-base-image', () => ({
  captureMarkupBaseImage: async () => ({
    dataUrl: 'data:image/png;base64,AA',
    width: 800,
    height: 600
  }),
  flattenCapturedPage: async (capture: unknown) => capture
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
  toasts.last = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        setGrabMode: async () => ({ ok: true, clean: true }),
        onGuestEscape: () => () => {},
        cancelGrab: async () => true,
        captureSelectionScreenshot: async () => ({ ok: false }),
        captureCleanPage: async () => ({
          dataUrl: 'data:image/png;base64,AA',
          width: 800,
          height: 600
        }),
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
        toolTargetId: PAGE_ID,
        ...browserPageDocumentIdentity({ id: PAGE_ID, loading: tab.loading }, 0)
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

function drawAndLeave(rendered: Rendered, shapes: MarkupShape[]): void {
  act(() => rendered.result.current.tools.reportShapes(shapes))
  act(() => rendered.result.current.tools.exit())
  rendered.rerender(LOADED)
}

describe('getting a discarded drawing back', () => {
  it('Draw again while Undo is on offer brings back the same page and strokes, without a new capture', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    const original = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [strokeA])
    expect(rendered.result.current.tools.activeTool).toBeNull()

    await enterDraw(rendered)

    expect(rendered.result.current.markup.baseImage).toBe(original)
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeA])
  })

  it('the Undo button brings it back too', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    const original = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [strokeA])

    act(() => toasts.last?.action?.onClick())

    expect(rendered.result.current.tools.activeTool).toBe('draw')
    expect(rendered.result.current.markup.baseImage).toBe(original)
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeA])
  })

  it.each(['Draw again', 'the Undo button'] as const)(
    'brings it back once only (restored by %s): cleared and left, a later Draw captures afresh',
    async (entry) => {
      const rendered = renderTools()
      await enterDraw(rendered)
      const original = rendered.result.current.markup.baseImage
      drawAndLeave(rendered, [strokeA])
      const undo = toasts.last?.action
      if (entry === 'Draw again') {
        await enterDraw(rendered)
      } else {
        act(() => undo?.onClick())
        await waitFor(() => expect(rendered.result.current.markup.state).toBe('drawing'))
      }
      expect(rendered.result.current.markup.baseImage).toBe(original)
      // Cleared, then left: nothing to offer back.
      drawAndLeave(rendered, [])
      // The earlier toast's Undo, still fading out, can't revive the consumed drawing either.
      act(() => undo?.onClick())
      expect(rendered.result.current.tools.activeTool).toBeNull()

      await enterDraw(rendered)

      expect(rendered.result.current.markup.baseImage).not.toBe(original)
      expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
    }
  )

  it('never replaces a drawing that is open now when an old Undo is pressed', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    const original = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [strokeA])
    const staleUndo = toasts.last?.action
    // The offer runs out, and a new drawing is started.
    act(() => toasts.last?.onAutoClose?.())
    await enterDraw(rendered)
    expect(rendered.result.current.markup.baseImage).not.toBe(original)

    const replacement = rendered.result.current.markup.baseImage
    act(() => staleUndo?.onClick())

    expect(rendered.result.current.markup.baseImage).toBe(replacement)
    expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
  })

  it('once the offer runs out, Draw captures afresh', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    const original = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [strokeA])

    act(() => toasts.last?.onAutoClose?.())
    await enterDraw(rendered)

    expect(rendered.result.current.markup.baseImage).not.toBe(original)
    expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
  })

  it('a newer discard replaces the older one', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    drawAndLeave(rendered, [strokeA])
    act(() => toasts.last?.onAutoClose?.())
    await enterDraw(rendered)
    const replacement = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [strokeB])

    await enterDraw(rendered)

    expect(rendered.result.current.markup.baseImage).toBe(replacement)
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeB])
  })

  it('a reload of the page withdraws the offer: Draw captures the new document', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    const original = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [strokeA])

    rendered.rerender({ ...LOADED, loading: true })
    rendered.rerender(LOADED)
    await enterDraw(rendered)

    expect(rendered.result.current.markup.baseImage).not.toBe(original)
    expect(rendered.result.current.tools.restoredShapes).toBeUndefined()
  })

  it('a same-document URL change (pushState, hash) keeps the offer: Draw still restores', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    const original = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [strokeA])

    rendered.rerender({ url: 'http://acme.test/#pricing', loading: false })
    rendered.rerender({ url: 'http://acme.test/plans', loading: false })
    await enterDraw(rendered)

    expect(rendered.result.current.markup.baseImage).toBe(original)
    expect(rendered.result.current.tools.restoredShapes).toEqual([strokeA])
  })

  it('leaving Draw with nothing drawn offers nothing back', async () => {
    const rendered = renderTools()
    await enterDraw(rendered)
    const original = rendered.result.current.markup.baseImage
    drawAndLeave(rendered, [])
    expect(toasts.last).toBeNull()

    await enterDraw(rendered)

    expect(rendered.result.current.markup.baseImage).not.toBe(original)
  })
})
