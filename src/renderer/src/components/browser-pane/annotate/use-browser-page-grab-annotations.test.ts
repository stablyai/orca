// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import type { BrowserGrabRecorder } from './browser-grab-recorder'
import { logGrabElementSelected } from './browser-grab-recorder'
import type { GrabModeHook } from './useGrabMode'
import { useBrowserPageGrabAnnotations } from './use-browser-page-grab-annotations'

// Why: these are module-scope singletons so every render sees the same
// function identities — matching production where zustand selectors and
// useCallback keep stable references (fresh identities would churn the
// effect deps and fake the very loop the tests guard against).
const { recordFeatureInteraction, addBrowserPageAnnotation, showGrabToast, dismissGrabToast } =
  vi.hoisted(() => ({
    recordFeatureInteraction: vi.fn(),
    addBrowserPageAnnotation: vi.fn(),
    showGrabToast: vi.fn(),
    dismissGrabToast: vi.fn()
  }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ recordFeatureInteraction, addBrowserPageAnnotation })
}))

vi.mock('./use-browser-page-overlay-viewport-sync', () => ({
  useBrowserPageOverlayViewportSync: () => {}
}))

vi.mock('./use-browser-page-grab-toast', () => ({
  useBrowserPageGrabToast: () => ({
    grabToast: null,
    setGrabToast: vi.fn(),
    grabToastTimerRef: { current: undefined },
    dismissGrabToast,
    showGrabToast
  })
}))

vi.mock('./browser-grab-recorder', () => ({
  logGrabAnnotationAdded: vi.fn(),
  logGrabElementSelected: vi.fn()
}))

function makePayload(): BrowserGrabPayload {
  return {
    page: {
      sanitizedUrl: 'https://example.com/path',
      title: 'Example',
      viewportWidth: 1280,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      capturedAt: '2026-08-18T00:00:00.000Z'
    },
    target: {
      tagName: 'BUTTON',
      selector: 'body > form > button',
      textSnippet: 'Kaydet',
      htmlSnippet: '<button>Kaydet</button>',
      attributes: {},
      accessibility: {
        role: 'button',
        accessibleName: 'Kaydet',
        ariaLabel: null,
        ariaLabelledBy: null
      },
      rectViewport: { x: 0, y: 0, width: 100, height: 40 },
      rectPage: { x: 0, y: 0, width: 100, height: 40 },
      computedStyles: {
        display: 'inline-block',
        position: 'static',
        width: '100px',
        height: '40px',
        margin: '0px',
        padding: '0px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgb(255, 255, 255)',
        border: '0px',
        borderRadius: '0px',
        fontFamily: 'sans-serif',
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: 'normal',
        textAlign: 'left',
        zIndex: 'auto'
      }
    },
    nearbyText: [],
    ancestorPath: [],
    screenshot: null
  }
}

function makeGrab(
  payload: BrowserGrabPayload | null,
  overrides: Partial<GrabModeHook> = {}
): GrabModeHook {
  return {
    state: 'confirming',
    payload,
    error: null,
    contextMenu: false,
    toggle: vi.fn(),
    cancel: vi.fn(),
    rearm: vi.fn(),
    exit: vi.fn(),
    ...overrides
  }
}

function makeRecorder(): BrowserGrabRecorder {
  return {
    recordingRef: { current: true },
    recordStep: vi.fn()
  }
}

function makeProps(
  grab: GrabModeHook,
  recorder: BrowserGrabRecorder
): Parameters<typeof useBrowserPageGrabAnnotations>[0] {
  return {
    browserTabId: 'tab-1',
    isActive: true,
    grab,
    containerRef: { current: null },
    webviewRef: { current: null },
    setBrowserOverlayViewport: vi.fn(),
    browserAnnotationsLength: 0,
    setBrowserAnnotationTrayOpen: vi.fn(),
    recorder
  }
}

describe('useBrowserPageGrabAnnotations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs a picked element once per pick while confirming, even when the recorder object identity changes every render', () => {
    const payload = makePayload()
    const grab = makeGrab(payload)
    const { rerender } = renderHook(
      ({ recorder }) => useBrowserPageGrabAnnotations(makeProps(grab, recorder)),
      { initialProps: { recorder: makeRecorder() } }
    )

    expect(logGrabElementSelected).toHaveBeenCalledTimes(1)

    // Why: browser-page-pane builds the recorder object inline, so every
    // render yields a new reference while the pick stays 'confirming'. The
    // confirm effect must not treat that identity churn as a new pick —
    // previously it re-logged the selection on every re-render (infinite
    // "Selected" stream until cancel).
    rerender({ recorder: makeRecorder() })
    rerender({ recorder: makeRecorder() })

    expect(logGrabElementSelected).toHaveBeenCalledTimes(1)
  })

  it('logs again only when a genuinely new pick arrives, and stays quiet once the pick leaves confirming', () => {
    const payloadA = makePayload()
    const payloadB = makePayload()
    const { rerender } = renderHook(
      ({ grab, recorder }) => useBrowserPageGrabAnnotations(makeProps(grab, recorder)),
      { initialProps: { grab: makeGrab(payloadA), recorder: makeRecorder() } }
    )

    expect(logGrabElementSelected).toHaveBeenCalledTimes(1)

    // Cancel leaves confirming — no further logging.
    rerender({
      grab: makeGrab(null, { state: 'armed' }),
      recorder: makeRecorder()
    })
    expect(logGrabElementSelected).toHaveBeenCalledTimes(1)

    // A fresh pick on a different element logs once.
    rerender({
      grab: makeGrab(payloadB),
      recorder: makeRecorder()
    })
    expect(logGrabElementSelected).toHaveBeenCalledTimes(2)
  })
})
