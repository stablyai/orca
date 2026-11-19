// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { makeAnnotation } from '@/store/slices/browser/annotations/browser-annotation-test-fixture'
import { useGrabMode } from '../grab/useGrabMode'
import { useBrowserPageGrabAnnotations } from '../grab/use-browser-page-grab-annotations'
import type { MarkupModeController, MarkupResumeSnapshot } from '../capture/useMarkupMode'
import type { MarkupShape } from '../drawing/markup-drawing-model'
import { useBrowserAnnotateToolSwitch } from './use-browser-annotate-tool-switch'

const toastMock = vi.hoisted(() => {
  const toast = Object.assign(
    vi.fn((_message: string, _options?: unknown) => 'toast-1'),
    {
      error: vi.fn(),
      dismiss: vi.fn()
    }
  )
  return toast
})
vi.mock('sonner', () => ({ toast: toastMock }))

const PAGE_ID = 'page-1'
const CONTAINER_REF = { current: null }
const WEBVIEW_REF = { current: null }
const noopSetViewport = (): void => {}
const pickedElement: BrowserGrabPayload = { ...makeAnnotation(PAGE_ID).payload, screenshot: null }

let resolvePick: ((payload: BrowserGrabPayload) => void) | null = null
const writeClipboardText = vi.fn(async () => {})
type SetGrabModeArgs = { browserPageId: string; enabled: boolean }
type SetGrabModeResult = { ok: true } | { ok: false; reason: 'injection-failed' }
// Arming resolves at once; a disable can be held open so a test controls when the page acknowledges teardown.
let heldDisable: ((result: SetGrabModeResult) => void) | null = null
let holdDisables = false
const setGrabMode = vi.fn((args: SetGrabModeArgs): Promise<SetGrabModeResult> =>
  !args.enabled && holdDisables
    ? new Promise((resolve) => {
        heldDisable = resolve
      })
    : Promise.resolve({ ok: true })
)

beforeEach(() => {
  resolvePick = null
  heldDisable = null
  holdDisables = false
  writeClipboardText.mockClear()
  setGrabMode.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        setGrabMode,
        onGuestEscape: () => () => {},
        cancelGrab: vi.fn(async () => true),
        captureSelectionScreenshot: vi.fn(async () => ({ ok: false })),
        // Each arm waits for the next pick; the test decides when the user clicks an element.
        awaitGrabSelection: vi.fn(
          ({ opId }: { opId: string }) =>
            new Promise((resolve) => {
              resolvePick = (payload) => resolve({ opId, kind: 'selected', payload })
            })
        )
      },
      ui: { writeClipboardText }
    }
  })
})

afterEach(() => vi.restoreAllMocks())

function makeMarkup(): MarkupModeController {
  return {
    state: 'idle',
    isActive: false,
    baseImage: null,
    start: vi.fn(async () => {}),
    cancel: vi.fn(),
    complete: vi.fn(async () => {}),
    snapshot: vi.fn(() => null),
    resume: vi.fn()
  }
}

function renderBrowserTools(markup: MarkupModeController) {
  return renderHook(() => {
    const grab = useGrabMode(PAGE_ID)
    const grabAnnotations = useBrowserPageGrabAnnotations({
      browserTabId: PAGE_ID,
      isActive: true,
      grab,
      containerRef: CONTAINER_REF,
      webviewRef: WEBVIEW_REF,
      setBrowserOverlayViewport: noopSetViewport,
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
      documentKey: 'http://acme.test/'
    })
    return { grab, grabAnnotations, tools }
  })
}

async function pickElement(): Promise<void> {
  await waitFor(() => expect(resolvePick).not.toBeNull())
  await act(async () => {
    resolvePick?.(pickedElement)
  })
}

describe('switching annotate tools', () => {
  it('keeps the mode on when the tool that is already on is picked again', async () => {
    const { result } = renderBrowserTools(makeMarkup())
    act(() => result.current.grabAnnotations.startGrabIntent('copy'))
    await waitFor(() => expect(result.current.grab.state).toBe('awaiting'))

    act(() => result.current.tools.selectTool('copy'))

    expect(result.current.tools.activeTool).toBe('copy')
    expect(result.current.grab.state).not.toBe('idle')
  })

  it('does not copy an earlier annotate pick when switching to Grab', async () => {
    const { result } = renderBrowserTools(makeMarkup())
    act(() => result.current.grabAnnotations.startGrabIntent('annotate'))
    await pickElement()
    await waitFor(() =>
      expect(result.current.grabAnnotations.pendingAnnotationPayload).not.toBeNull()
    )

    act(() => result.current.tools.selectTool('copy'))

    expect(result.current.tools.activeTool).toBe('copy')
    expect(result.current.grabAnnotations.pendingAnnotationPayload).toBeNull()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('does not open a comment card for an earlier Grab pick when switching to Annotate', async () => {
    const { result } = renderBrowserTools(makeMarkup())
    act(() => result.current.grabAnnotations.startGrabIntent('copy'))
    await pickElement()
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1))

    act(() => result.current.tools.selectTool('annotate'))

    expect(result.current.tools.activeTool).toBe('annotate')
    expect(result.current.grabAnnotations.pendingAnnotationPayload).toBeNull()
    expect(writeClipboardText).toHaveBeenCalledTimes(1)
  })

  it('drops an unsaved comment card and captures for Draw only after the page acknowledges teardown', async () => {
    const markup = makeMarkup()
    const { result } = renderBrowserTools(markup)
    act(() => result.current.grabAnnotations.startGrabIntent('annotate'))
    await pickElement()
    await waitFor(() =>
      expect(result.current.grabAnnotations.pendingAnnotationPayload).not.toBeNull()
    )
    holdDisables = true

    act(() => result.current.tools.selectTool('draw'))
    // The palette stays on Draw while the picker's page overlay is torn down.
    expect(result.current.tools.activeTool).toBe('draw')
    expect(result.current.grabAnnotations.pendingAnnotationPayload).toBeNull()
    await waitFor(() => expect(heldDisable).not.toBeNull())
    expect(markup.start).not.toHaveBeenCalled()

    await act(async () => heldDisable?.({ ok: true }))
    expect(markup.start).toHaveBeenCalledTimes(1)
  })

  it('does not capture for Draw when the page cannot confirm teardown', async () => {
    const markup = makeMarkup()
    const { result } = renderBrowserTools(markup)
    act(() => result.current.grabAnnotations.startGrabIntent('copy'))
    await waitFor(() => expect(result.current.grab.state).toBe('awaiting'))
    holdDisables = true

    act(() => result.current.tools.selectTool('draw'))
    await waitFor(() => expect(heldDisable).not.toBeNull())
    await act(async () => heldDisable?.({ ok: false, reason: 'injection-failed' }))

    expect(markup.start).not.toHaveBeenCalled()
    expect(result.current.tools.activeTool).toBeNull()
  })

  it('drops a pending Draw start when the user switches back before teardown finishes', async () => {
    const markup = makeMarkup()
    const { result } = renderBrowserTools(markup)
    act(() => result.current.grabAnnotations.startGrabIntent('copy'))
    await waitFor(() => expect(result.current.grab.state).toBe('awaiting'))
    holdDisables = true

    act(() => result.current.tools.selectTool('draw'))
    await waitFor(() => expect(heldDisable).not.toBeNull())
    const releaseTeardown = heldDisable
    holdDisables = false
    act(() => result.current.tools.selectTool('copy'))
    await act(async () => releaseTeardown?.({ ok: true }))

    expect(markup.start).not.toHaveBeenCalled()
    expect(result.current.tools.activeTool).toBe('copy')
  })

  it('a Grab chord during an annotate pick drops the pick instead of copying it', async () => {
    const { result } = renderBrowserTools(makeMarkup())
    act(() => result.current.grabAnnotations.startGrabIntent('annotate'))
    await pickElement()
    await waitFor(() =>
      expect(result.current.grabAnnotations.pendingAnnotationPayload).not.toBeNull()
    )

    // The chord path calls the owning transition directly, not through the palette.
    act(() => result.current.grabAnnotations.startGrabIntent('copy'))

    expect(result.current.grab.state).not.toBe('idle')
    expect(result.current.grabAnnotations.pendingAnnotationPayload).toBeNull()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('Done drops an unsaved comment card and leaves the mode', async () => {
    const { result } = renderBrowserTools(makeMarkup())
    act(() => result.current.grabAnnotations.startGrabIntent('annotate'))
    await pickElement()
    await waitFor(() =>
      expect(result.current.grabAnnotations.pendingAnnotationPayload).not.toBeNull()
    )

    act(() => result.current.tools.exit())

    expect(result.current.tools.activeTool).toBeNull()
    expect(result.current.grabAnnotations.pendingAnnotationPayload).toBeNull()
  })

  it('offers Undo after leaving Draw with a drawing, and Undo reopens the same drawing', () => {
    const saved: MarkupResumeSnapshot = {
      baseImage: { dataUrl: 'data:image/png;base64,AA', width: 800, height: 600 },
      context: {
        source: { kind: 'image', element: document.createElement('img') },
        cssWidth: 800,
        cssHeight: 600,
        outputScale: 1
      }
    }
    const markup: MarkupModeController = {
      ...makeMarkup(),
      state: 'drawing',
      isActive: true,
      snapshot: vi.fn(() => saved)
    }
    // Cancelling really ends the drawing, as the real controller does.
    markup.cancel = vi.fn(() => {
      markup.isActive = false
      markup.state = 'idle'
    })
    const { result, rerender } = renderBrowserTools(markup)
    const stroke: MarkupShape = {
      id: 'stroke-1',
      color: '#ef4444',
      kind: 'rect',
      from: { x: 10, y: 10 },
      to: { x: 60, y: 40 },
      width: 4
    }
    act(() => result.current.tools.reportShapes([stroke]))

    act(() => result.current.tools.exit())
    expect(markup.cancel).toHaveBeenCalledTimes(1)
    // The pane re-renders with Draw closed before anyone can click Undo.
    rerender()
    const options: unknown = toastMock.mock.calls.at(-1)?.[1]
    const undo =
      typeof options === 'object' && options !== null && 'action' in options ? options.action : null
    expect(undo).toMatchObject({ label: 'Undo' })

    act(() => {
      if (
        typeof undo === 'object' &&
        undo !== null &&
        'onClick' in undo &&
        typeof undo.onClick === 'function'
      ) {
        undo.onClick()
      }
    })
    expect(markup.resume).toHaveBeenCalledWith(saved)
    expect(result.current.tools.restoredShapes).toEqual([stroke])
  })

  it('never lets Undo replace a drawing that is open', () => {
    const saved: MarkupResumeSnapshot = {
      baseImage: { dataUrl: 'data:image/png;base64,AA', width: 800, height: 600 },
      context: {
        source: { kind: 'image', element: document.createElement('img') },
        cssWidth: 800,
        cssHeight: 600,
        outputScale: 1
      }
    }
    const markup: MarkupModeController = {
      ...makeMarkup(),
      state: 'drawing',
      isActive: true,
      snapshot: vi.fn(() => saved)
    }
    const { result } = renderBrowserTools(markup)
    act(() =>
      result.current.tools.reportShapes([
        {
          id: 's',
          color: '#ef4444',
          kind: 'rect',
          from: { x: 1, y: 1 },
          to: { x: 9, y: 9 },
          width: 4
        }
      ])
    )
    act(() => result.current.tools.exit())
    const options: unknown = toastMock.mock.calls.at(-1)?.[1]
    const undo =
      typeof options === 'object' && options !== null && 'action' in options ? options.action : null

    // A new drawing is open by the time Undo is clicked (the mock stays active).
    act(() => {
      if (
        typeof undo === 'object' &&
        undo !== null &&
        'onClick' in undo &&
        typeof undo.onClick === 'function'
      ) {
        undo.onClick()
      }
    })

    expect(markup.resume).not.toHaveBeenCalled()
  })

  it('restores a discarded drawing once only: after Undo, a later Draw starts fresh', async () => {
    const saved: MarkupResumeSnapshot = {
      baseImage: { dataUrl: 'data:image/png;base64,AA', width: 800, height: 600 },
      context: {
        source: { kind: 'image', element: document.createElement('img') },
        cssWidth: 800,
        cssHeight: 600,
        outputScale: 1
      }
    }
    const markup: MarkupModeController = {
      ...makeMarkup(),
      state: 'drawing',
      isActive: true,
      snapshot: vi.fn(() => saved)
    }
    markup.cancel = vi.fn(() => {
      markup.isActive = false
      markup.state = 'idle'
    })
    markup.resume = vi.fn(() => {
      markup.isActive = true
      markup.state = 'drawing'
    })
    const { result, rerender } = renderBrowserTools(markup)
    act(() =>
      result.current.tools.reportShapes([
        {
          id: 's',
          color: '#ef4444',
          kind: 'rect',
          from: { x: 1, y: 1 },
          to: { x: 9, y: 9 },
          width: 4
        }
      ])
    )
    act(() => result.current.tools.exit())
    rerender()
    const options: unknown = toastMock.mock.calls.at(-1)?.[1]
    const undo =
      typeof options === 'object' && options !== null && 'action' in options ? options.action : null
    act(() => {
      if (
        typeof undo === 'object' &&
        undo !== null &&
        'onClick' in undo &&
        typeof undo.onClick === 'function'
      ) {
        undo.onClick()
      }
    })
    rerender()
    expect(markup.resume).toHaveBeenCalledTimes(1)

    // The user clears the restored strokes and leaves; nothing is left to undo.
    act(() => result.current.tools.reportShapes([]))
    act(() => result.current.tools.exit())
    rerender()

    // Draw again: a fresh capture, never the old drawing a second time.
    await act(async () => result.current.tools.selectTool('draw'))
    await waitFor(() => expect(markup.start).toHaveBeenCalledTimes(1))
    expect(markup.resume).toHaveBeenCalledTimes(1)
  })

  it('leaves Draw without an Undo offer when nothing was drawn', () => {
    const markup = { ...makeMarkup(), state: 'drawing' as const, isActive: true }
    toastMock.mockClear()
    const { result } = renderBrowserTools(markup)

    act(() => result.current.tools.exit())

    expect(markup.cancel).toHaveBeenCalledTimes(1)
    expect(toastMock).not.toHaveBeenCalled()
  })
})
