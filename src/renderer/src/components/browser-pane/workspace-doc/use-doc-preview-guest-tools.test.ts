// @vitest-environment happy-dom
//
// One id runs through this hook, and it is the browser page. A re-mint replaces the guest under
// that page rather than renaming the surface, so annotations stay addressable and the tool target
// keeps naming something main can resolve — the two used to be separate ids, and swapping them was
// invisible until a preview re-minted.
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../../../../shared/browser-annotation-viewport-bridge'
import { makeAnnotation } from '@/store/slices/browser-annotation-test-fixture'
import { getBrowserOverlayAnchor } from '../describe-page/browser-annotation-geometry'
import { attachDocPreviewWebview } from './doc-preview-webview-attach'

type GuestToolCalls = {
  annotationSend: { browserTabId: string }[]
  grabAnnotations: { browserTabId: string; toolTargetId: string }[]
  grabMode: string[]
  viewportBridge: { toolTargetId: string; token: string }[]
}

const calls = vi.hoisted<GuestToolCalls>(() => ({
  annotationSend: [],
  grabAnnotations: [],
  grabMode: [],
  viewportBridge: []
}))

let pendingPayload: BrowserGrabPayload | null = null

vi.mock('@/components/browser-pane/annotate/use-browser-page-annotation-send', () => ({
  useBrowserPageAnnotationSend: (args: { browserTabId: string }) => {
    calls.annotationSend.push({ browserTabId: args.browserTabId })
    return { browserAnnotations: [] }
  }
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-grab-annotations', () => ({
  useBrowserPageGrabAnnotations: (args: { browserTabId: string; toolTargetId: string }) => {
    calls.grabAnnotations.push({
      browserTabId: args.browserTabId,
      toolTargetId: args.toolTargetId
    })
    return {
      pendingAnnotationPayload: pendingPayload,
      grabIntent: null,
      startGrabIntent: () => undefined
    }
  }
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-markup-capture', () => ({
  useBrowserPageMarkupCapture: () => ({ isActive: false })
}))

vi.mock('@/components/browser-pane/annotate/useGrabMode', () => ({
  useGrabMode: (toolTargetId: string) => {
    calls.grabMode.push(toolTargetId)
    return { state: 'idle' }
  }
}))

vi.mock('@/components/browser-pane/annotate/guest-annotation-viewport-bridge', () => ({
  syncGuestAnnotationViewportBridge: (args: { toolTargetId: string; token: string }) => {
    calls.viewportBridge.push({ toolTargetId: args.toolTargetId, token: args.token })
  }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'G' }))

import { useDocPreviewGuestTools } from './use-doc-preview-guest-tools'

const PREVIEW_ID = 'browser-page-9f2c'
const FIRST_GRANT = 'a'.repeat(32)
const SECOND_GRANT = 'b'.repeat(32)

function Harness({ grantId }: { grantId: string | null }): null {
  const webviewRef = useRef(null)
  const containerRef = useRef(null)
  latestTools = useDocPreviewGuestTools({
    previewId: PREVIEW_ID,
    worktreeId: 'wt-1',
    grantId,
    webviewRef: webviewRef as never,
    containerRef: containerRef as never,
    toolsReady: true
  })
  return null
}

let container: HTMLDivElement
let root: Root
let latestTools: ReturnType<typeof useDocPreviewGuestTools> | null = null

function currentTools(): ReturnType<typeof useDocPreviewGuestTools> {
  if (!latestTools) {
    throw new Error('preview tools not rendered')
  }
  return latestTools
}

function render(grantId: string | null): void {
  act(() => {
    root.render(createElement(Harness, { grantId }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  calls.annotationSend.length = 0
  calls.grabAnnotations.length = 0
  calls.grabMode.length = 0
  calls.viewportBridge.length = 0
  pendingPayload = null
  latestTools = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useDocPreviewGuestTools ids', () => {
  it('scopes annotations and tools to the browser page the document is open in', () => {
    render(FIRST_GRANT)

    expect(calls.annotationSend.at(-1)?.browserTabId).toBe(PREVIEW_ID)
    expect(calls.grabAnnotations.at(-1)?.browserTabId).toBe(PREVIEW_ID)
    expect(calls.grabAnnotations.at(-1)?.toolTargetId).toBe(PREVIEW_ID)
    expect(calls.grabMode.at(-1)).toBe(PREVIEW_ID)
  })

  // Why a re-mint is still worth a test with one id: main re-points the page at the replacement
  // guest, so the surface the reader is looking at must keep the same name through it. A hook that
  // rebuilt its target from the grant would orphan annotations under an id nothing reads again.
  it('keeps naming the same surface across a re-mint', () => {
    render(FIRST_GRANT)
    render(SECOND_GRANT)

    expect(new Set(calls.annotationSend.map((call) => call.browserTabId))).toEqual(
      new Set([PREVIEW_ID])
    )
    expect(new Set(calls.grabAnnotations.map((call) => call.toolTargetId))).toEqual(
      new Set([PREVIEW_ID])
    )
    expect(calls.viewportBridge.at(-1)?.toolTargetId).toBe(PREVIEW_ID)
  })

  // Why an empty target and not the page id: before a grant exists no guest has committed to this
  // page, so naming it would park every tool request in the registration wait for a document the
  // reader may never get.
  it('names no tool target before a grant exists', () => {
    render(null)

    expect(calls.grabMode.at(-1)).toBe('')
    expect(calls.grabAnnotations.at(-1)?.toolTargetId).toBe('')
    expect(calls.viewportBridge).toHaveLength(0)
  })

  it('moves the pending card from a live report after inner scroll and removes the listener on detach', () => {
    const selected = makeAnnotation(PREVIEW_ID).payload
    selected.page.viewportWidth = 900
    selected.target.rectPage = { x: 40, y: 300, width: 120, height: 30 }
    selected.target.rectViewport = { x: 40, y: 300, width: 120, height: 30 }
    pendingPayload = selected
    render(FIRST_GRANT)
    const token = calls.viewportBridge.at(-1)?.token
    expect(token).toBeTruthy()

    const previewContainer = document.createElement('div')
    document.body.appendChild(previewContainer)
    const attached = attachDocPreviewWebview({
      previewId: PREVIEW_ID,
      container: previewContainer,
      url: 'orca-preview://grant/index.html',
      ariaLabel: 'HTML preview',
      onLoadStarted: () => currentTools().resetBrowserOverlayViewport(),
      onLoadStopped: vi.fn(),
      onLoadFailed: vi.fn(),
      onNavigated: vi.fn(),
      onTitleUpdated: vi.fn(),
      onViewportMessage: currentTools().handleAnnotationViewportMessage
    })
    const pane = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 900 })
    }
    const cardY = (): number =>
      getBrowserOverlayAnchor(selected, pane, pane, currentTools().browserOverlayViewport).y
    const send = (message: string): void => {
      act(() => {
        attached.webview.dispatchEvent(Object.assign(new Event('console-message'), { message }))
      })
    }

    try {
      expect(cardY()).toBe(330)
      const report = JSON.stringify({
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 900,
        target: { x: 40, y: 120, width: 120, height: 30 }
      })
      send(`${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}wrong-token:${report}`)
      expect(cardY()).toBe(330)
      send(`${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${token}:${report}`)
      expect(cardY()).toBe(150)

      act(() => attached.webview.dispatchEvent(new Event('did-start-loading')))
      expect(cardY()).toBe(330)
      attached.detach()
      send(`${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${token}:${report}`)
      expect(cardY()).toBe(330)
    } finally {
      attached.detach()
      previewContainer.remove()
    }
  })
})
