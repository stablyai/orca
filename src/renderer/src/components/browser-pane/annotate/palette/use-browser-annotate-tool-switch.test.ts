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
// Image writes are held so a test decides when the clipboard finishes.
let finishImageWrite: (() => void) | null = null
const writeClipboardImage = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      finishImageWrite = resolve
    })
)
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
  finishImageWrite = null
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
      ui: { writeClipboardText, writeClipboardImage }
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

type PageProps = { documentKey: string; documentReady: boolean; canPickElements: boolean }
const FIRST_PAGE: PageProps = {
  documentKey: 'http://acme.test/',
  documentReady: true,
  canPickElements: true
}

function renderBrowserTools(markup: MarkupModeController) {
  return renderHook(
    ({ documentKey, documentReady, canPickElements }: PageProps) => {
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
        canPickElements,
        toolTargetId: PAGE_ID,
        documentKey,
        documentReady
      })
      return { grab, grabAnnotations, tools }
    },
    { initialProps: FIRST_PAGE }
  )
}

/** Starts Draw from a live Grab pick and leaves its overlay teardown waiting on the page. */
async function startDrawWithTeardownHeld(
  result: ReturnType<typeof renderBrowserTools>['result']
): Promise<(value: SetGrabModeResult) => void> {
  act(() => result.current.grabAnnotations.startGrabIntent('copy'))
  await waitFor(() => expect(result.current.grab.state).toBe('awaiting'))
  holdDisables = true
  act(() => result.current.tools.selectTool('draw'))
  await waitFor(() => expect(heldDisable).not.toBeNull())
  const release = heldDisable
  if (!release) {
    throw new Error('teardown was not requested')
  }
  return release
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

  it.each([
    ['an awaiting Grab pick', 'copy', false],
    ['a confirming Annotate card', 'annotate', true]
  ] as const)(
    'from %s, Draw cancels the pick, then awaits teardown, then captures',
    async (_label, intent, pick) => {
      const markup = makeMarkup()
      const cancelGrab = vi.mocked(window.api.browser.cancelGrab)
      const { result } = renderBrowserTools(markup)
      act(() => result.current.grabAnnotations.startGrabIntent(intent))
      if (pick) {
        await pickElement()
        await waitFor(() => expect(result.current.grab.state).toBe('confirming'))
      } else {
        await waitFor(() => expect(result.current.grab.state).toBe('awaiting'))
      }
      setGrabMode.mockClear()
      cancelGrab.mockClear()
      holdDisables = true

      act(() => result.current.tools.selectTool('draw'))
      await waitFor(() => expect(heldDisable).not.toBeNull())
      // The disable that Draw awaits is the last page call before capture.
      const disableCalls = setGrabMode.mock.calls.filter(([args]) => !args.enabled)
      expect(disableCalls.length).toBeGreaterThan(0)
      expect(result.current.grab.state).toBe('idle')
      expect(markup.start).not.toHaveBeenCalled()

      await act(async () => heldDisable?.({ ok: true }))
      expect(markup.start).toHaveBeenCalledTimes(1)
      expect(
        Math.max(...setGrabMode.mock.invocationCallOrder, ...cancelGrab.mock.invocationCallOrder)
      ).toBeLessThan(vi.mocked(markup.start).mock.invocationCallOrder[0])
    }
  )

  it('drops a pending Draw when the page leaves and comes back to the same address (A → B → A)', async () => {
    const markup = makeMarkup()
    const { result, rerender } = renderBrowserTools(markup)
    const release = await startDrawWithTeardownHeld(result)

    rerender({ ...FIRST_PAGE, documentKey: 'http://acme.test/other' })
    rerender(FIRST_PAGE)
    expect(result.current.tools.activeTool).toBeNull()
    await act(async () => release({ ok: true }))

    expect(markup.start).not.toHaveBeenCalled()
    expect(result.current.tools.activeTool).toBeNull()
  })

  it('drops a pending Draw when the same address reloads before teardown finishes', async () => {
    const markup = makeMarkup()
    const { result, rerender } = renderBrowserTools(markup)
    const release = await startDrawWithTeardownHeld(result)

    rerender({ ...FIRST_PAGE, documentReady: false })
    rerender(FIRST_PAGE)
    await act(async () => release({ ok: true }))

    expect(markup.start).not.toHaveBeenCalled()
    expect(result.current.tools.activeTool).toBeNull()
  })

  it('drops a pending Draw when the page stops being drawable, and does not come back on Draw later', async () => {
    const markup = makeMarkup()
    const { result, rerender } = renderBrowserTools(markup)
    const release = await startDrawWithTeardownHeld(result)

    rerender({ ...FIRST_PAGE, canPickElements: false })
    expect(result.current.tools.activeTool).toBeNull()
    rerender(FIRST_PAGE)
    await act(async () => release({ ok: true }))

    expect(markup.start).not.toHaveBeenCalled()
    // Not stuck showing Draw for a start that will never finish.
    expect(result.current.tools.activeTool).toBeNull()
  })

  it('withdraws the Undo offer when the page reloads', () => {
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
    rerender(FIRST_PAGE)
    expect(toastMock).toHaveBeenCalled()
    toastMock.dismiss.mockClear()

    rerender({ ...FIRST_PAGE, documentReady: false })

    expect(toastMock.dismiss).toHaveBeenCalledWith('toast-1')
  })

  it('a screenshot copy that finishes after switching to Annotate shows no Grab feedback there', async () => {
    const { result } = renderBrowserTools(makeMarkup())
    act(() => result.current.grabAnnotations.startGrabIntent('copy'))
    await pickElement()
    await waitFor(() => expect(result.current.grab.state).toBe('confirming'))
    // The palette's Screenshot acts on the pick it holds.
    act(() =>
      result.current.grabAnnotations.handleGrabCopyScreenshot({
        ...pickedElement,
        screenshot: {
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AA',
          width: 4,
          height: 4
        }
      })
    )
    expect(writeClipboardImage).toHaveBeenCalledTimes(1)

    act(() => result.current.tools.selectTool('annotate'))
    expect(result.current.grabAnnotations.grabToast).toBeNull()
    await act(async () => finishImageWrite?.())

    expect(result.current.grabAnnotations.grabToast).toBeNull()
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
    rerender(FIRST_PAGE)
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
    rerender(FIRST_PAGE)
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
    rerender(FIRST_PAGE)
    expect(markup.resume).toHaveBeenCalledTimes(1)

    // The user clears the restored strokes and leaves; nothing is left to undo.
    act(() => result.current.tools.reportShapes([]))
    act(() => result.current.tools.exit())
    rerender(FIRST_PAGE)

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
