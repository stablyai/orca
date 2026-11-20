// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { makeAnnotation } from '@/store/slices/browser/annotations/browser-annotation-test-fixture'
import { useGrabMode } from '../grab/useGrabMode'
import { useBrowserPageGrabAnnotations } from '../grab/use-browser-page-grab-annotations'
import type { MarkupModeController } from '../capture/useMarkupMode'
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

  it('a Draw asked for while the page is still loading captures only once the load ends', async () => {
    const markup = makeMarkup()
    const { result, rerender } = renderBrowserTools(markup)
    rerender({ ...FIRST_PAGE, documentReady: false })
    const release = await startDrawWithTeardownHeld(result)

    await act(async () => release({ ok: true }))
    expect(markup.start).not.toHaveBeenCalled()
    expect(result.current.tools.activeTool).toBe('draw')

    rerender(FIRST_PAGE)
    await waitFor(() => expect(markup.start).toHaveBeenCalledTimes(1))
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
})
